import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { findMobArtifactByChunk, getOrCreateMobArtifact } from '@/db/mobArtifacts';
import { createRulebook } from '@/db/rulebookRepo';
import { encounterDataSchema, monsterSourceSchema, newId, npcDataSchema, ruleChunkSchema, stampNewEntity, statBlockSchema } from '@/domain';
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
