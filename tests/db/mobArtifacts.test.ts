import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createModule } from '@/db/moduleRepo';
import { findMobArtifactByChunk, getOrCreateMobArtifact, spawnMobArtifactIntoModule } from '@/db/mobArtifacts';
import { createRulebook } from '@/db/rulebookRepo';
import { createModule as createModuleSchema, encounterDataSchema, monsterSourceSchema, newId, npcDataSchema, ruleChunkSchema, stampNewEntity, statBlockSchema } from '@/domain';
import { db } from '@/db/db';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from './helpers';

/**
 * Mob artifacts (owner-ratified mob-artifact arc): a bestiary creature cited
 * by chunk becomes ONE image-able npc artifact per campaign per chunkId —
 * the get-or-create helper shared by runEngine finalize (both remap sites)
 * and battleSeed's lazy retro-fill. Additive-zod pins cover old rows.
 */

const GOBLIN_TEXT = 'Goblin Boss, humanoid, agile commander.';

let campaignId = '';

async function seedGoblinChunk(): Promise<{ chunkId: string; text: string }> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      pageStart: 12,
      pageEnd: 12,
      chunkType: 'statblock',
      headingPath: ['Goblin Boss'],
      text: GOBLIN_TEXT,
      statBlock: statBlockSchema.parse({
        system: 'dnd5e',
        level: '1',
        size: 'Small',
        creatureType: 'humanoid (goblinoid)',
        ac: 17,
        acNote: '',
        hp: 21,
        hpFormula: '3d6 + 11',
        speed: '30 ft.',
        abilities: { str: 14, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
        saves: '',
        skills: '',
        senses: 'darkvision 60 ft.',
        languages: 'Common, Goblin',
        traits: [],
        actions: [],
        reactions: [],
        legendary: [],
        extras: {},
      }),
      contentHash: await sha256Hex(GOBLIN_TEXT),
    }),
  ]);
  const { db } = await import('@/db/db');
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  if (chunk === undefined) throw new Error('chunk missing');
  return { chunkId: chunk.id, text: chunk.text };
}

beforeEach(async () => {
  await clearDatabase();
  campaignId = (await createCampaign({ name: 'Mob campaign', system: 'dnd5e' })).id;
});

describe('getOrCreateMobArtifact', () => {
  it('creates ONE npc artifact per chunk: roster name + marker, no stat duplication', async () => {
    const { chunkId } = await seedGoblinChunk();
    const mobArtifactId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const artifacts = await listArtifactsByCampaign(campaignId);
    const mob = artifacts.find((artifact) => artifact.id === mobArtifactId);
    expect(mob?.kind).toBe('npc');
    expect(mob?.name).toBe('Goblin Boss');
    if (mob?.kind !== 'npc') throw new Error('not an npc');
    // The marker keys the artifact to its chunk; nothing else is copied —
    // the chunk stays the source of truth (no stat duplication).
    expect(mob.data.monsterChunkId).toBe(chunkId);
    expect(mob.data.statBlock).toBeNull();
    expect(mob.data.appearance).toBe('');
    expect(mob.body).toBe('');
    expect(mob.summary).toBe('');
    expect(mob.links).toEqual([]);
  });

  it('is idempotent: repeated calls (and one run citing it twice) converge on the same artifact', async () => {
    const { chunkId } = await seedGoblinChunk();
    const first = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const second = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const cache = new Map<string, string>();
    cache.set(chunkId, first);
    const viaCache = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss', undefined, cache);
    expect(second).toBe(first);
    expect(viaCache).toBe(first);
    const mobs = (await listArtifactsByCampaign(campaignId)).filter(
      (artifact) => artifact.kind === 'npc' && artifact.data.monsterChunkId !== undefined,
    );
    expect(mobs).toHaveLength(1);
  });

  it('reuses an existing artifact verbatim — the first roster name wins', async () => {
    const { chunkId } = await seedGoblinChunk();
    const first = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const second = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Chief');
    expect(second).toBe(first);
    const mob = await findMobArtifactByChunk(campaignId, chunkId);
    expect(mob?.name).toBe('Goblin Boss');
  });

  it('fails loudly on an empty roster name (no unnamed artifact)', async () => {
    const { chunkId } = await seedGoblinChunk();
    await expect(getOrCreateMobArtifact(campaignId, chunkId, '   ')).rejects.toThrow('empty name');
    expect(await findMobArtifactByChunk(campaignId, chunkId)).toBeUndefined();
  });

  it('scopes by campaign: another campaign citing the same chunk gets its own artifact', async () => {
    const { chunkId } = await seedGoblinChunk();
    const otherCampaignId = (await createCampaign({ name: 'Elsewhere', system: 'dnd5e' })).id;
    const here = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const there = await getOrCreateMobArtifact(otherCampaignId, chunkId, 'Goblin Boss');
    expect(there).not.toBe(here);
    expect(await findMobArtifactByChunk(campaignId, chunkId)).toMatchObject({ id: here });
    expect(await findMobArtifactByChunk(otherCampaignId, chunkId)).toMatchObject({ id: there });
  });

  it('findMobArtifactByChunk misses unknown chunks', async () => {
    await seedGoblinChunk();
    expect(await findMobArtifactByChunk(campaignId, newId())).toBeUndefined();
  });
});

describe('additive zod (old rows parse unchanged)', () => {
  it('a pre-marker rulebook source parses with mobArtifactId absent', () => {
    const parsed = monsterSourceSchema.parse({ type: 'rulebook', chunkId: newId() });
    expect(parsed).toMatchObject({ type: 'rulebook' });
    if (parsed.type !== 'rulebook') throw new Error('wrong variant');
    expect(parsed.mobArtifactId).toBeUndefined();
  });

  it('a pre-marker npc data object parses with monsterChunkId absent', () => {
    const parsed = npcDataSchema.parse({ appearance: 'tall', personality: 'grim', statBlock: null });
    expect(parsed.monsterChunkId).toBeUndefined();
  });

  it('a pre-marker encounter data object parses unchanged (backup round-trip shape)', () => {
    const parsed = encounterDataSchema.parse({
      difficulty: 'medium',
      levelHint: '3',
      monsters: [
        { name: 'Goblin', count: 2, notes: '', source: { type: 'rulebook', chunkId: newId() } },
      ],
      terrain: '',
      tactics: '',
      treasure: '',
    });
    expect(parsed.mapImageId).toBeNull();
    expect(parsed.layout).toBeNull();
    expect(parsed.monsters[0]?.source).toMatchObject({ type: 'rulebook' });
  });
});

describe('spawnMobArtifactIntoModule', () => {
  it('creates the mob artifact and stamps module ownership (moduleId + module:<title> tag)', async () => {
    const { chunkId } = await seedGoblinChunk();
    const vault = await createModule(
      createModuleSchema({ campaignId, title: 'The Sunless Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );

    const { artifactId, stamped } = await spawnMobArtifactIntoModule(
      campaignId, chunkId, 'Goblin Boss', vault.id, vault.title,
    );

    expect(stamped).toBe(true);
    const mob = await getArtifact(artifactId);
    if (mob === undefined) throw new Error('mob artifact missing');
    expect(mob.moduleId).toBe(vault.id);
    expect(mob.tags).toContain(`module:${vault.title}`);
    expect(mob.currentRevision).toBe(2); // creation + ownership stamp
    const revisions = await db.revisions.where('artifactId').equals(artifactId).toArray();
    expect(revisions.length).toBe(2);
  });

  it('is idempotent for the same module: no second stamp, no revision churn', async () => {
    const { chunkId } = await seedGoblinChunk();
    const vault = await createModule(
      createModuleSchema({ campaignId, title: 'The Sunless Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await spawnMobArtifactIntoModule(campaignId, chunkId, 'Goblin Boss', vault.id, vault.title);
    const before = (await getArtifact(
      (await findMobArtifactByChunk(campaignId, chunkId))?.id ?? newId(),
    ))?.currentRevision;

    const second = await spawnMobArtifactIntoModule(campaignId, chunkId, 'Goblin Boss', vault.id, vault.title);

    expect(second.stamped).toBe(false);
    const mob = await findMobArtifactByChunk(campaignId, chunkId);
    expect(mob?.currentRevision).toBe(before);
    expect(mob?.moduleId).toBe(vault.id);
  });

  it('moves the artifact when spawned into a different module (single placement, tag history kept)', async () => {
    const { chunkId } = await seedGoblinChunk();
    const vault = await createModule(
      createModuleSchema({ campaignId, title: 'The Sunless Vault', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    const mill = await createModule(
      createModuleSchema({ campaignId, title: 'The Old Mill', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );
    await spawnMobArtifactIntoModule(campaignId, chunkId, 'Goblin Boss', vault.id, vault.title);

    const moved = await spawnMobArtifactIntoModule(campaignId, chunkId, 'Goblin Boss', mill.id, mill.title);

    expect(moved.stamped).toBe(true);
    const mob = await findMobArtifactByChunk(campaignId, chunkId);
    expect(mob?.moduleId).toBe(mill.id); // single placement — it moved
    expect(mob?.tags).toContain(`module:${vault.title}`); // history kept
    expect(mob?.tags).toContain(`module:${mill.title}`);
  });

  it('stamps an artifact that already existed from an earlier encounter run', async () => {
    const { chunkId } = await seedGoblinChunk();
    const existingId = await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    const crypt = await createModule(
      createModuleSchema({ campaignId, title: 'Ember Crypt', concept: '', levelMin: 1, levelMax: 3, sizeDial: 'sketch' }),
    );

    const { artifactId, stamped } = await spawnMobArtifactIntoModule(
      campaignId, chunkId, 'Goblin Boss', crypt.id, crypt.title,
    );

    expect(artifactId).toBe(existingId);
    expect(stamped).toBe(true);
    expect((await getArtifact(artifactId))?.moduleId).toBe(crypt.id);
  });
});

/**
 * Race window pin (F5): the scan + create run in ONE rw transaction, so
 * concurrent get-or-creates for the same chunk serialize on it and converge
 * on ONE artifact (the ratified one-artifact-per-chunk rule). The previous
 * check-then-act across two transactions could materialize duplicates.
 */
describe('getOrCreateMobArtifact concurrency', () => {
  beforeEach(async () => {
    await clearDatabase();
    campaignId = (await createCampaign({ name: 'Mob concurrency', system: 'dnd5e' })).id;
  });

  it('eight concurrent get-or-creates for one chunk converge on one artifact', async () => {
    const { chunkId } = await seedGoblinChunk();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss')),
    );
    expect(new Set(ids).size).toBe(1);
    const mobs = (await listArtifactsByCampaign(campaignId)).filter(
      (artifact) => artifact.kind === 'npc' && artifact.data.monsterChunkId === chunkId,
    );
    expect(mobs).toHaveLength(1);
  });

  it('structurally wraps the scan+create in a single rw transaction', async () => {
    const { chunkId } = await seedGoblinChunk();
    const calls: unknown[][] = [];
    const original = db.transaction.bind(db) as (...args: unknown[]) => unknown;
    const target = db as unknown as { transaction: (...args: unknown[]) => unknown };
    target.transaction = (...args: unknown[]) => {
      calls.push(args);
      return original(...args);
    };
    try {
      await getOrCreateMobArtifact(campaignId, chunkId, 'Goblin Boss');
    } finally {
      target.transaction = original;
    }
    // Exactly one call passes the table ARRAY (the outer get-or-create tx);
    // createArtifact's nested tx passes the tables variadically.
    const arrayForm = calls.filter((args) => args[0] === 'rw' && Array.isArray(args[1]));
    expect(arrayForm).toHaveLength(1);
  });
});
