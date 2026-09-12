import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId, ruleChunkSchema, stampNewEntity, statBlockSchema, type StatBlock } from '@/domain';
import { contentIdentityFor } from '@/domain/encounterResolve';
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
 * named `missing ref (Name)` origin instead of crashing.
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
      treasure: '',
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
      treasure: '',
      source: { type: 'npc-ref', artifactId: npc.id },
    });
    expect(resolved.origin).toBe('NPC: Plain Villager');
    expect(resolved.statBlock).toBeNull();
  });

  it('degrades a dangling npc-ref to the NAMED missing-ref reason', async () => {
    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Ghost',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: newId() },
    });
    // The ONE surviving reason, and it NAMES the creature (docs/11 D9): the old
    // bare 'missing ref' left the panel with nothing to search the library for.
    expect(resolved.origin).toBe('missing ref (Ghost)');
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
      treasure: '',
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
      treasure: '',
      source: { type: 'rulebook', chunkId: chunks[0]?.id ?? '' },
    });
    expect(resolved.origin).toBe('PF2e Bestiary: Goblin Warrior');
    expect(resolved.statBlock?.creatureType).toBe('humanoid');
  });

  it('resolves a dnd5e pack chunk to "<book title>: <creature name>" (M-C)', async () => {
    const book = await createPackBook({ title: 'D&D 5e SRD Bestiary', system: 'dnd5e', filename: 'srd-bestiary.zip' });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-dnd5e-srd',
      license: 'CC-BY-4.0 attribution',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    const text = 'Ape stat block';
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Ape'],
        text,
        statBlock: statBlock({ level: '1/2', creatureType: 'beast' }),
        contentHash: await sha256Hex(text),
      }),
    ]);
    const chunks = await db.chunks.toArray();

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Ape',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: chunks[0]?.id ?? '' },
    });
    expect(resolved.origin).toBe('D&D 5e SRD Bestiary: Ape');
    expect(resolved.statBlock?.level).toBe('1/2');
  });

  it('degrades a dangling rulebook chunk to "missing ref"', async () => {
    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Owlbear',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: newId() },
    });
    expect(resolved.origin).toBe('missing ref (Owlbear)');
    expect(resolved.statBlock).toBeNull();
  });

  it('passes inline stat blocks through with origin "inline" and name-only entries to ""', async () => {
    const inline = await resolveMonsterEntryWithRepos({
      name: 'Bandit',
      count: 4,
      notes: '',
      treasure: '',
      source: { type: 'inline', statBlock: statBlock() },
    });
    expect(inline.origin).toBe('inline');
    expect(inline.statBlock).not.toBeNull();

    const none = await resolveMonsterEntryWithRepos({
      name: 'Something unnamed',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'none' },
    });
    expect(none.origin).toBe('');
    expect(none.statBlock).toBeNull();
  });
});

/**
 * Content-identity fallback (chunk-hash-fallback arc): a rulebook citation
 * whose uuid misses but whose stamped hash hits byte-identical local
 * content resolves exactly like a uuid hit — stats and the LOCAL row's
 * label. Exact hash only: same creature under a new hash stays missing.
 */
describe('resolveMonsterEntry content-hash fallback', () => {
  beforeEach(clearDatabase);

  async function installPackChunk(
    text: string,
    heading: string,
    block: StatBlock | null,
  ): Promise<{ chunkId: string; contentHash: string }> {
    const book = await createPackBook({ title: 'Monster Core', system: 'pathfinder2e', filename: 'mc.zip' });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 1,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    const contentHash = await sha256Hex(text);
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: [heading],
        text,
        statBlock: block,
        contentHash,
      }),
    ]);
    const [chunk] = await db.chunks.where('bookId').equals(book.id).toArray();
    if (chunk?.id === undefined) throw new Error('chunk missing');
    return { chunkId: chunk.id, contentHash };
  }

  it('uuid-miss + hash-hit resolves the LOCAL chunk stats and pack label', async () => {
    const text = 'Goblin Warrior stat block';
    const { contentHash } = await installPackChunk(text, 'Goblin Warrior', statBlock({ creatureType: 'humanoid' }));

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Goblin Warrior',
      count: 2,
      notes: '',
      treasure: '',
      // A foreign install's uuid (re-ingest under a new row id) + the
      // stamped content hash from citation birth.
      source: { type: 'rulebook', chunkId: newId(), contentHash, creatureName: 'Goblin Warrior' },
    });
    expect(resolved.origin).toBe('Monster Core: Goblin Warrior');
    expect(resolved.statBlock?.creatureType).toBe('humanoid');
  });

  it('uuid-miss + hash-hit resolves a PDF chunk with the LOCAL page label', async () => {
    const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
    const text = 'Troll stat block, local printing';
    const contentHash = await sha256Hex(text);
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 77,
        pageEnd: 77,
        chunkType: 'statblock',
        headingPath: ['Troll'],
        text,
        statBlock: statBlock(),
        contentHash,
      }),
    ]);

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Troll',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: newId(), contentHash, creatureName: 'Troll' },
    });
    expect(resolved.origin).toBe('Bestiary p.77');
    expect(resolved.statBlock?.level).toBe('3');
  });

  it('prefers the statful chunk when several local chunks share one hash', async () => {
    const text = 'Duplicated goblin text';
    const contentHash = await sha256Hex(text);
    const book = await createPackBook({ title: 'Monster Core', system: 'pathfinder2e', filename: 'mc.zip' });
    await finalizePackBook(book.id, {
      sourceId: 'foundry-pf2e',
      license: 'Community Use Policy',
      entriesImported: 2,
      entriesSkipped: 0,
      entriesFailed: 0,
    });
    await putChunks([
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock: null,
        contentHash,
      }),
      ruleChunkSchema.parse({
        ...stampNewEntity(),
        bookId: book.id,
        pageStart: 1,
        pageEnd: 1,
        chunkType: 'statblock',
        headingPath: ['Goblin Warrior'],
        text,
        statBlock: statBlock({ creatureType: 'humanoid' }),
        contentHash,
      }),
    ]);

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Goblin Warrior',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: newId(), contentHash, creatureName: 'Goblin Warrior' },
    });
    expect(resolved.statBlock?.creatureType).toBe('humanoid');
  });

  it('hash-hit on a statless chunk stays missing', async () => {
    const { contentHash } = await installPackChunk('Unparsed goblin text', 'Goblin Warrior', null);

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Goblin Warrior',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: newId(), contentHash, creatureName: 'Goblin Warrior' },
    });
    expect(resolved).toMatchObject({ statBlock: null, origin: 'missing ref (Goblin Warrior)' });
  });

  it('uuid-miss + unknown hash stays missing', async () => {
    await installPackChunk('Goblin Warrior stat block', 'Goblin Warrior', statBlock());

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Goblin Warrior',
      count: 1,
      notes: '',
      treasure: '',
      source: {
        type: 'rulebook',
        chunkId: newId(),
        contentHash: await sha256Hex('bytes no library holds'),
        creatureName: 'Goblin Warrior',
      },
    });
    expect(resolved).toMatchObject({ statBlock: null, origin: 'missing ref (Goblin Warrior)' });
  });

  it('same creature under a new hash stays missing (L1 deferred, exact-only)', async () => {
    const { contentHash } = await installPackChunk('Goblin Warrior stat block', 'Goblin Warrior', statBlock());
    // Same creature re-ingested with revised bytes: the import dep dialog
    // reports version drift, but the resolver stays exact-only.
    const revisedHash = await sha256Hex('Goblin Warrior stat block, revised printing');

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Goblin Warrior',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: newId(), contentHash: revisedHash, creatureName: 'Goblin Warrior' },
    });
    expect(resolved).toMatchObject({ statBlock: null, origin: 'missing ref (Goblin Warrior)' });
    expect(contentHash).not.toBe(revisedHash);
  });

  it('uuid-miss with no stamped hash stays missing', async () => {
    await installPackChunk('Goblin Warrior stat block', 'Goblin Warrior', statBlock());

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Goblin Warrior',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'rulebook', chunkId: newId() },
    });
    expect(resolved).toMatchObject({ statBlock: null, origin: 'missing ref (Goblin Warrior)' });
  });
});

describe('contentIdentityFor', () => {
  it('passes the hash through and takes the trimmed heading', () => {
    expect(contentIdentityFor('ab'.repeat(32), '  Goblin Warrior  ', 'Goblin')).toEqual({
      contentHash: 'ab'.repeat(32),
      creatureName: 'Goblin Warrior',
    });
  });

  it('falls back to the entry name on an empty or missing heading', () => {
    expect(contentIdentityFor('ab'.repeat(32), '', 'Goblin')).toEqual({
      contentHash: 'ab'.repeat(32),
      creatureName: 'Goblin',
    });
    expect(contentIdentityFor('ab'.repeat(32), undefined, 'Goblin')).toEqual({
      contentHash: 'ab'.repeat(32),
      creatureName: 'Goblin',
    });
  });
});
