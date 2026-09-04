import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId, ruleChunkSchema, stampNewEntity, statBlockSchema, type StatBlock } from '@/domain';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createPackBook, createRulebook, finalizePackBook } from '@/db/rulebookRepo';
import { putChunks } from '@/db/chunkRepo';
import { sha256Hex } from '@/lib/hash';
import { db } from '@/db/db';
import { clearDatabase } from './helpers';

/**
 * Monster source resolution (07-MILESTONE-3 M3-B): NPC links, rulebook
 * chunks, inline stats — and dangling references that degrade to a
 * "missing ref" origin instead of crashing.
 */

function statBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '3',
    size: 'Large',
    creatureType: 'giant',
    ac: 15,
    acNote: '',
    hp: 84,
    hpFormula: '7d10+21',
    speed: '40 ft.',
    abilities: { str: 18, dex: 10, con: 16, int: 6, wis: 10, cha: 8 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [{ name: 'Keen Smell', text: 'Advantage on Perception.' }],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

describe('resolveMonsterEntryWithRepos', () => {
  beforeEach(clearDatabase);

  it('resolves an npc-ref entry to the NPC artifact stat block', async () => {
    const campaign = await createCampaign({ name: 'C', system: 'dnd5e' });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Vexra',
      data: {
        appearance: '',
        personality: '',
        statBlock: statBlock({ creatureType: 'aberration' }),
      },
    });

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Vexra',
      count: 1,
      notes: '',
      source: { type: 'npc-ref', artifactId: npc.id },
    });
    expect(resolved.origin).toBe('NPC: Vexra');
    expect(resolved.statBlock?.creatureType).toBe('aberration');
  });

  it('resolves an npc artifact without stats to origin but no stat block', async () => {
    const campaign = await createCampaign({ name: 'C', system: 'dnd5e' });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Plain Villager',
      data: {
        appearance: '',
        personality: '',
        statBlock: null,
      },
    });
    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Villager',
      count: 3,
      notes: '',
      source: { type: 'npc-ref', artifactId: npc.id },
    });
    expect(resolved.origin).toBe('NPC: Plain Villager');
    expect(resolved.statBlock).toBeNull();
  });

  it('degrades a dangling npc-ref to "missing ref"', async () => {
    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Ghost',
      count: 1,
      notes: '',
      source: { type: 'npc-ref', artifactId: newId() },
    });
    expect(resolved.origin).toBe('missing ref');
    expect(resolved.statBlock).toBeNull();
  });

  it('resolves a rulebook chunk to "<book title> p. N"', async () => {
    const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
    const text = 'Troll stat block';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 132,
        pageEnd: 132,
        chunkType: 'statblock',
        headingPath: ['Troll'],
        text,
        statBlock: statBlock(),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const chunks = await db.chunks.toArray();

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Troll',
      count: 2,
      notes: '',
      source: { type: 'rulebook', chunkId: chunks[0]?.id ?? '' },
    });
    expect(resolved.origin).toBe('Bestiary p.132');
    expect(resolved.statBlock?.level).toBe('3');
  });

  it('resolves a pack chunk to "<book title>: <creature name>" without a page', async () => {
    // Pack chunks have no page numbers (12-BESTIARY-PACKS §4): the origin
    // label names the creature from headingPath[0] instead.
    const book = await createPackBook({ title: 'PF2e Bestiary', system: 'pathfinder2e', filename: 'bestiary.zip' });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 1,
      entriesSkipped: 0,
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
        statBlock: statBlock({ creatureType: 'humanoid' }),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const chunks = await db.chunks.toArray();

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Goblin Warrior',
      count: 4,
      notes: '',
      source: { type: 'rulebook', chunkId: chunks[0]?.id ?? '' },
    });
    expect(resolved.origin).toBe('PF2e Bestiary: Goblin Warrior');
    expect(resolved.statBlock?.creatureType).toBe('humanoid');
  });

  it('degrades a dangling rulebook chunk to "missing ref"', async () => {
    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Owlbear',
      count: 1,
      notes: '',
      source: { type: 'rulebook', chunkId: newId() },
    });
    expect(resolved.origin).toBe('missing ref');
    expect(resolved.statBlock).toBeNull();
  });

  it('passes inline stat blocks through with origin "inline" and name-only entries to ""', async () => {
    const inline = await resolveMonsterEntryWithRepos({
      name: 'Bandit',
      count: 4,
      notes: '',
      source: { type: 'inline', statBlock: statBlock() },
    });
    expect(inline.origin).toBe('inline');
    expect(inline.statBlock).not.toBeNull();

    const none = await resolveMonsterEntryWithRepos({
      name: 'Something unnamed',
      count: 1,
      notes: '',
      source: { type: 'none' },
    });
    expect(none.origin).toBe('');
    expect(none.statBlock).toBeNull();
  });
});
