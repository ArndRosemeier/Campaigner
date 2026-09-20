import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { newId, ruleChunkSchema, stampNewEntity, statBlockSchema, type StatBlock } from '@/domain';
import {
  citationBookTitle,
  contentIdentityFor,
  missingRefReason,
  rulebookDisplayTitle,
} from '@/domain/encounterResolve';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import { copyCreatureStatsFromDb } from '@/db/libraryCopy';
import {
  EMPTY_CREATURE_CITATION_REASON,
  MISSING_CREATURE_CHUNK_REASON,
  STATLESS_CREATURE_CHUNK_REASON,
} from '@/domain/libraryCopy';
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
      source: { type: 'none' as const },
    });
    expect(none.origin).toBe('');
    expect(none.statBlock).toBeNull();
  });
});

/**
 * Content-identity fallback (chunk-hash-fallback arc), now the COPY seam's own
 * rule: `copyCreatureStats` tries the citation's uuid first and its stamped
 * content hash second, so a re-ingest under a new row id still copies. Exact
 * hash only — the same creature under a NEW hash is unresolved (the import dep
 * dialog reports that drift).
 */
describe('copyCreatureStats content-hash fallback', () => {
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

  it('uuid-miss + hash-hit copies the LOCAL chunk stats and stamps the pack label', async () => {
    const text = 'Goblin Warrior stat block';
    const { contentHash } = await installPackChunk(text, 'Goblin Warrior', statBlock({ creatureType: 'humanoid' }));

    // A foreign install's uuid (re-ingest under a new row id) + the stamped
    // content hash from citation birth.
    const copy = await copyCreatureStatsFromDb({ chunkId: newId(), contentHash }, 'Goblin Warrior');
    if (copy.status !== 'copied') throw new Error('the hash fallback did not copy');
    expect(copy.copy.sourceLine).toBe('Monster Core: Goblin Warrior');
    expect(copy.copy.statBlock.creatureType).toBe('humanoid');
  });

  it('uuid-miss + hash-hit copies a PDF chunk with the LOCAL page label', async () => {
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

    const copy = await copyCreatureStatsFromDb({ chunkId: newId(), contentHash }, 'Troll');
    if (copy.status !== 'copied') throw new Error('the hash fallback did not copy');
    expect(copy.copy.sourceLine).toBe('Bestiary p.77');
    expect(copy.copy.statBlock.level).toBe('3');
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

    const copy = await copyCreatureStatsFromDb({ chunkId: newId(), contentHash }, 'Goblin Warrior');
    if (copy.status !== 'copied') throw new Error('the statful chunk was not preferred');
    expect(copy.copy.statBlock.creatureType).toBe('humanoid');
  });

  it('a hash hit on a statless chunk is unresolved with the NAMED reason', async () => {
    const { contentHash } = await installPackChunk('Unparsed goblin text', 'Goblin Warrior', null);
    const copy = await copyCreatureStatsFromDb({ chunkId: newId(), contentHash }, 'Goblin Warrior');
    expect(copy).toEqual({ status: 'unresolved', reason: STATLESS_CREATURE_CHUNK_REASON });
  });

  it('a uuid-miss + unknown hash is unresolved (no silent empty copy)', async () => {
    await installPackChunk('Goblin Warrior stat block', 'Goblin Warrior', statBlock());
    const copy = await copyCreatureStatsFromDb(
      { chunkId: newId(), contentHash: await sha256Hex('other bytes') },
      'Goblin Warrior',
    );
    expect(copy).toEqual({ status: 'unresolved', reason: MISSING_CREATURE_CHUNK_REASON });
  });

  it('the same creature under a NEW hash is unresolved (exact-only, L1 deferred)', async () => {
    const { contentHash } = await installPackChunk('Goblin Warrior stat block', 'Goblin Warrior', statBlock());
    const revisedHash = await sha256Hex('Goblin Warrior stat block, revised printing');
    const copy = await copyCreatureStatsFromDb({ chunkId: newId(), contentHash: revisedHash }, 'Goblin Warrior');
    expect(copy).toEqual({ status: 'unresolved', reason: MISSING_CREATURE_CHUNK_REASON });
    expect(contentHash).not.toBe(revisedHash);
  });

  it('a citation with neither key is unresolved by NAME (a dead pointer is loud)', async () => {
    const copy = await copyCreatureStatsFromDb({}, 'Goblin Warrior');
    expect(copy).toEqual({ status: 'unresolved', reason: EMPTY_CREATURE_CITATION_REASON });
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

  it('stamps the book title it is handed, trimmed — the citation names its pack', () => {
    expect(contentIdentityFor('ab'.repeat(32), 'Goblin Warrior', 'Goblin', '  Monster Core  ')).toEqual(
      {
        contentHash: 'ab'.repeat(32),
        creatureName: 'Goblin Warrior',
        bookTitle: 'Monster Core',
      },
    );
  });

  it('OMITS the book title when none is known — never an empty placeholder', () => {
    for (const unknown of [undefined, '', '   ']) {
      const identity = contentIdentityFor('ab'.repeat(32), 'Goblin Warrior', 'Goblin', unknown);
      expect('bookTitle' in identity).toBe(false);
      expect(identity.creatureName).toBe('Goblin Warrior');
    }
  });
});

describe('missingRefReason', () => {
  it('builds the label and the structured reason TOGETHER, pack included', () => {
    expect(missingRefReason('  Zombie  ', '  Monster Manual  ')).toEqual({
      origin: 'missing ref (Zombie)',
      missingRef: { creature: 'Zombie', bookTitle: 'Monster Manual' },
    });
  });

  it('omits the book when the citation records none, and says nothing it does not know', () => {
    expect(missingRefReason('Zombie')).toEqual({
      origin: 'missing ref (Zombie)',
      missingRef: { creature: 'Zombie' },
    });
    const blank = missingRefReason('Zombie', '   ');
    expect('bookTitle' in blank.missingRef).toBe(false);
  });

  it('names nothing rather than inventing a creature for a citation that records none', () => {
    expect(missingRefReason('', 'Monster Manual')).toEqual({
      origin: 'missing ref',
      missingRef: { creature: '', bookTitle: 'Monster Manual' },
    });
  });
});

describe('the book title a citation STAMPS and the one an origin label PRINTS', () => {
  it('are the same identity for a real book row — they cannot name two different books', async () => {
    const book = await createPackBook({
      title: 'Monster Core',
      system: 'pathfinder2e',
      filename: 'monster-core.zip',
    });
    expect(citationBookTitle(book)).toBe('Monster Core');
    expect(rulebookDisplayTitle(book)).toBe('Monster Core');
  });

  it('REFUSES to stamp a title it does not have, while a label still prints its stand-in', async () => {
    // The two readings are deliberately different questions: a LABEL always has
    // to print something, a STAMP must never invent one (AGENTS rule 1).
    expect(citationBookTitle(undefined)).toBeUndefined();
    expect(rulebookDisplayTitle(undefined)).toBe('Rulebook');
    const blank = await createPackBook({
      title: ' ',
      system: 'pathfinder2e',
      filename: 'blank.zip',
    });
    expect(citationBookTitle(blank)).toBeUndefined();
    // The label's rule is byte-identical to the pre-155 reading (an EMPTY
    // title is the only one it replaces); a whitespace title prints verbatim
    // rather than being quietly rewritten.
    expect(rulebookDisplayTitle(blank)).toBe(' ');
  });
});
