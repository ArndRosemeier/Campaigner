import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArtifact, getAnyArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { getBattleByModule } from '@/db/battleRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { castCreatureAsNpc, resolveCreatureCitation, resolveDerivedNpcStats } from '@/db/creatureRepo';
import { db } from '@/db/db';
import { createImage } from '@/db/imageRepo';
import {
  getMobPortraitCacheEntry,
  storeCanonicalPortraitIfAbsent,
} from '@/db/mobPortraitCache';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import {
  contentCreatureKey,
  createModule,
  creatureIdentityForCitation,
  creatureRefSchema,
  libraryCreatureKey,
  npcDataSchema,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type StatBlock,
} from '@/domain';
import { isMissingRefOrigin, missingCreatureOrigin } from '@/domain/encounterResolve';
import { sha256Hex } from '@/lib/hash';
import { clearDatabase } from './helpers';

/**
 * THE CREATURE TIER'S CONTRACT (docs/11 §Core mobs, docs/18 §2).
 *
 * Three facts hold the whole model up, and each one is a place a future edit
 * can silently undo the arc:
 *
 * 1. **A citation resolves, or it says why** (D3/D9). A resource is found by
 *    chunk id, or — when the workspace was re-ingested under new row ids — by
 *    the content hash recorded at citation birth. A ref that carries neither is
 *    an ERROR, never a silent "no stats".
 * 2. **Casting is idempotent per identity and never overwrites** (D4). The
 *    second cast of the same creature REUSES its row; a row of that name that
 *    already draws from a DIFFERENT creature is a rival and is refused loudly.
 * 3. **The library is read-only and the encounter side may only cite** (D5/D8).
 *    Nothing in the citation path writes a library row, and no encounter data
 *    can express a cast at all.
 */
beforeEach(async () => {
  await clearDatabase();
});

afterEach(async () => {
  await clearDatabase();
});

async function seedCreep(name: string, hp: number): Promise<string> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'b.pdf' });
  const text = `${name}\nLarge undead, unaligned\nArmor Class 8\nHit Points ${String(hp)}`;
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: 4,
    pageEnd: 4,
    chunkType: 'statblock',
    headingPath: [name],
    text,
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level: '1',
      size: 'Large',
      creatureType: 'undead',
      ac: 8,
      acNote: '',
      hp,
      hpFormula: '3d10',
      speed: '20 ft.',
      abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
      saves: '',
      skills: '',
      senses: '',
      languages: '',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: {},
    }),
    contentHash: await sha256Hex(text),
  });
  await putChunks([chunk]);
  return chunk.id;
}

describe('D3 — a citation resolves by chunk id, then by content hash, and refuses an empty ref', () => {
  it('resolves the stat block through the cited chunk', async () => {
    const chunkId = await seedCreep('Bog Zombie', 22);
    const listing = await resolveCreatureCitation({ chunkId, creatureName: 'Bog Zombie' }, 'Bog Zombie');
    expect(listing.chunk?.id).toBe(chunkId);
    expect(listing.statBlock?.hp).toBe(22);
  });

  it('falls back to the content hash when the chunk row id changed (a re-ingest)', async () => {
    const chunkId = await seedCreep('Bog Zombie', 22);
    const row = await db.chunks.get(chunkId);
    if (row === undefined) throw new Error('chunk missing');
    const hash = row.contentHash;
    // The workspace is re-ingested: the SAME text lands under a NEW row id and
    // the old id is gone. The citation still holds the hash it recorded.
    await db.chunks.delete(chunkId);
    const reId = await seedCreep('Bog Zombie', 22);

    const byHash = await resolveCreatureCitation({ contentHash: hash }, 'Bog Zombie');
    expect(byHash.chunk?.id).toBe(reId);

    // …and the citation that carried BOTH keeps working through the id.
    const byBoth = await resolveCreatureCitation({ chunkId: reId, contentHash: hash }, 'Bog Zombie');
    expect(byBoth.chunk?.id).toBe(reId);
    expect(byBoth.statBlock?.hp).toBe(22);
  });

  it('THROWS on a ref that carries neither — never a silent "no stats"', async () => {
    await expect(resolveCreatureCitation({}, 'Ghost')).rejects.toThrow(
      'creature citation for "Ghost" carries neither a chunk id nor a content hash — nothing can resolve it',
    );
  });

  it('reports a citation the workspace cannot supply by NAME, without inventing stats', async () => {
    const listing = await resolveCreatureCitation({ chunkId: crypto.randomUUID() }, 'Absent Ghoul');
    expect(listing.chunk).toBeNull();
    expect(listing.statBlock).toBeNull();
    expect(listing.origin).toContain('Absent Ghoul');
    const derived = await resolveDerivedNpcStats('Absent Ghoul', { chunkId: crypto.randomUUID() });
    expect(derived.statBlock).toBeNull();
  });

  it('a derived NPC carries the LIBRARY stat block and says where it came from', async () => {
    const chunkId = await seedCreep('Bog Zombie', 22);
    const derived = await resolveDerivedNpcStats('Aunt Agatha', { chunkId, creatureName: 'Bog Zombie' });
    expect(derived.statBlock?.hp).toBe(22);
    // The origin names BOTH the npc and where its numbers came from, so a
    // reader is never shown borrowed numbers without their source.
    expect(derived.origin).toContain('NPC: Aunt Agatha (stats from ');
    expect(derived.origin.length).toBeGreaterThan('NPC: Aunt Agatha (stats from )'.length);
  });
});

describe('D3 — the schema refuses an authored stat block AND a citation on the same row', () => {
  const block: StatBlock = statBlockSchema.parse({
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'undead',
    ac: 10,
    acNote: '',
    hp: 5,
    hpFormula: '1d8',
    speed: '30 ft.',
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });

  it('accepts either one alone', () => {
    expect(npcDataSchema.safeParse({ appearance: '', personality: '', statBlock: block }).success).toBe(true);
    expect(
      npcDataSchema.safeParse({
        appearance: '',
        personality: '',
        statBlock: null,
        creatureRef: { chunkId: crypto.randomUUID() },
      }).success,
    ).toBe(true);
  });

  it('refuses both, naming the conflict and the remedy', () => {
    const parsed = npcDataSchema.safeParse({
      appearance: '',
      personality: '',
      statBlock: block,
      creatureRef: { chunkId: crypto.randomUUID() },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('the conflict was accepted');
    const message = parsed.error.issues.map((issue) => issue.message).join('\n');
    expect(message).toContain('either an authored stat block or a library creatureRef');
    expect(message).toContain('clear the stat block or drop the creature reference');
  });

  it('a ref is a POINTER, never a resolution key: its own schema refuses a non-uuid chunk', () => {
    expect(creatureRefSchema.safeParse({ chunkId: 'chunk:1' }).success).toBe(false);
    expect(creatureRefSchema.safeParse({ chunkId: crypto.randomUUID() }).success).toBe(true);
  });
});

describe('D4 — casting is idempotent per identity, and a rival is refused loudly', () => {
  it('CREATES once and REUSES on the second cast, writing nothing new', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await saveModule(createModule({
      campaignId: campaign.id,
      title: 'Vault',
      concept: 'c',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard',
    }));
    const chunkId = await seedCreep('Bog Zombie', 22);

    const first = await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId: module.id,
      citation: { chunkId, creatureName: 'Bog Zombie' },
      name: 'Aunt Agatha',
      prose: { summary: 'She shuffles.', body: '# Aunt Agatha' },
    });
    expect(first.status).toBe('created');

    const before = await getAnyArtifact(first.artifactId);
    const second = await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId: module.id,
      citation: { chunkId, creatureName: 'Bog Zombie' },
      name: 'Aunt Agatha',
    });
    expect(second.status).toBe('reused');
    expect(second.artifactId).toBe(first.artifactId);
    // Byte-identical: a second cast never rewrites the prose the owner has.
    expect(await getAnyArtifact(first.artifactId)).toEqual(before);
    expect(
      (await listArtifactsByCampaign(campaign.id)).filter((row) => row.name === 'Aunt Agatha'),
    ).toHaveLength(1);
  });

  it('the cast row cites the creature, owns its prose, and carries no authored stat block', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const chunkId = await seedCreep('Bog Zombie', 22);
    const cast = await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId: null,
      citation: { chunkId, creatureName: 'Bog Zombie' },
      name: 'Aunt Agatha',
      prose: { summary: 'Zombie numbers, her own words.', appearance: 'Sunday best.' },
    });
    const row = await getAnyArtifact(cast.artifactId);
    if (row?.kind !== 'npc') throw new Error('the cast row is not an npc');
    expect(row.data.creatureRef).toEqual({ chunkId, creatureName: 'Bog Zombie' });
    expect(row.data.statBlock).toBeNull();
    expect(row.summary).toBe('Zombie numbers, her own words.');
    expect(row.data.appearance).toBe('Sunday best.');
    // The identity is the LIBRARY one — the portrait key, not the row id and
    // not the name: `creatureIdentityForCitation` takes the RESOLVED chunk id,
    // which is what makes a cast share the creature's canonical portrait.
    const identity = creatureIdentityForCitation({ chunkId, creatureName: 'Bog Zombie' }, chunkId);
    expect(identity.key).toBe(libraryCreatureKey(chunkId));
    expect(identity.ref).toEqual({ chunkId, creatureName: 'Bog Zombie' });
  });

  it('REFUSES a rival of the same name drawing from a DIFFERENT creature', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const zombie = await seedCreep('Bog Zombie', 22);
    const ghoul = await seedCreep('Bog Ghoul', 44);
    await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId: null,
      citation: { chunkId: zombie, creatureName: 'Bog Zombie' },
      name: 'The Revenant',
    });

    await expect(
      castCreatureAsNpc({
        campaignId: campaign.id,
        moduleId: null,
        citation: { chunkId: ghoul, creatureName: 'Bog Ghoul' },
        name: 'The Revenant',
      }),
    ).rejects.toThrow(/already exists in this scope drawing its stats from a DIFFERENT library creature/);
    // …and it wrote nothing.
    expect(
      (await listArtifactsByCampaign(campaign.id)).filter((row) => row.name === 'The Revenant'),
    ).toHaveLength(1);
  });

  it('REFUSES to cast over an authored npc of that name', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const chunkId = await seedCreep('Bog Zombie', 22);
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Aunt Agatha',
      summary: 'Hand-written, thank you.',
      body: 'b',
      data: { appearance: '', personality: '', statBlock: null },
    });

    await expect(
      castCreatureAsNpc({
        campaignId: campaign.id,
        moduleId: null,
        citation: { chunkId, creatureName: 'Bog Zombie' },
        name: 'Aunt Agatha',
      }),
    ).rejects.toThrow(/already exists in this scope as an authored NPC/);
    const rows = (await listArtifactsByCampaign(campaign.id)).filter((row) => row.name === 'Aunt Agatha');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind !== 'npc') throw new Error('not an npc');
    // The authored prose is untouched: the refusal is what protected it.
    expect(row.summary).toBe('Hand-written, thank you.');
    expect(row.data.creatureRef).toBeUndefined();
  });

  it('REFUSES a creature the library cannot supply — never a row with a silent hole', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await expect(
      castCreatureAsNpc({
        campaignId: campaign.id,
        moduleId: null,
        citation: { chunkId: crypto.randomUUID(), creatureName: 'Nothing' },
        name: 'Nothing',
      }),
    ).rejects.toThrow(/refusing to cast «Nothing» — the cited library creature is not in this workspace/);
    expect(await listArtifactsByCampaign(campaign.id)).toEqual([]);
  });

  it('REFUSES a cast into a module that no longer exists (never a dangling owner)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const chunkId = await seedCreep('Bog Zombie', 22);
    await expect(
      castCreatureAsNpc({
        campaignId: campaign.id,
        moduleId: crypto.randomUUID(),
        citation: { chunkId, creatureName: 'Bog Zombie' },
        name: 'Aunt Agatha',
      }),
    ).rejects.toThrow(/no longer exists — re-anchor the entity before casting/);
  });
});

describe('D4 — the cast seeds the creature portrait, and never overwrites one', () => {
  it('seeds the cover from the canonical portrait, and leaves an imaged row ALONE', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const chunkId = await seedCreep('Bog Zombie', 22);
    const canonical = await createImage({
      campaignId: null,
      blob: new Blob(['canonical'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'uploaded',
    });
    const stored = await storeCanonicalPortraitIfAbsent(libraryCreatureKey(chunkId), canonical);
    expect(stored.stored).toBe(true);

    const first = await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId: null,
      citation: { chunkId, creatureName: 'Bog Zombie' },
      name: 'Aunt Agatha',
    });
    const seeded = await getAnyArtifact(first.artifactId);
    expect(seeded?.coverImageId === null || seeded?.coverImageId === undefined).toBe(false);

    // A second cast of the SAME identity reuses the row and skips the seeding:
    // the portrait the owner may have replaced is not touched.
    await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId: null,
      citation: { chunkId, creatureName: 'Bog Zombie' },
      name: 'Aunt Agatha',
    });
    expect((await getAnyArtifact(first.artifactId))?.coverImageId).toBe(seeded?.coverImageId);
  });

  it('a creature with no canonical portrait casts to a row with NO cover (null is normal, not an error)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const chunkId = await seedCreep('Bog Zombie', 22);
    const cast = await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId: null,
      citation: { chunkId, creatureName: 'Bog Zombie' },
      name: 'Aunt Agatha',
    });
    expect(await getMobPortraitCacheEntry(libraryCreatureKey(chunkId))).toBeUndefined();
    expect((await getAnyArtifact(cast.artifactId))?.coverImageId).toBeNull();
  });

  it('an INVENTED creature has a content identity, and its own name is the whole key', () => {
    // Written as the ONE derivation, so a future edit cannot quietly make two
    // invented creatures of the same name share a portrait.
    expect(contentCreatureKey('Gloom Ooze', null)).not.toBe(contentCreatureKey('Gloom Ooze', { hp: 9 }));
    expect(contentCreatureKey(' Gloom Ooze ', null)).toBe(contentCreatureKey('Gloom Ooze', null));
    expect(() => contentCreatureKey('   ', null)).toThrow(
      'creature identity: a creature with no name has no content identity',
    );
  });
});

describe('D9 — exactly ONE surviving "missing ref" reason, named where a name is known', () => {
  it('names the artifact when it has a name, and says the bare stem otherwise', () => {
    expect(missingCreatureOrigin('Ghost')).toBe('missing ref (Ghost)');
    expect(missingCreatureOrigin('')).toBe('missing ref');
  });

  it('the predicate the banner and the roster badge read matches every reason that exists', () => {
    // The bug this pins: the surfaces compared the origin to the exact string
    // 'missing ref' while the resolver had started returning a NAMED reason, so
    // the banner went silent. A property, not a sample.
    for (const name of ['Ghost', 'Ghost Lumberjack', '', 'Goblin Boss']) {
      expect(isMissingRefOrigin(missingCreatureOrigin(name))).toBe(true);
    }
    // …and nothing else is mistaken for it.
    for (const other of ['missing creature', 'not resolved', 'dangling', 'unresolved ref']) {
      expect(isMissingRefOrigin(other)).toBe(false);
    }
  });
});

describe('D5/D8 — the encounter side may cite, and the library is read-only', () => {
  it('no encounter data can express a cast — the schema drops the field outright', async () => {
    const { encounterDataSchema } = await import('@/domain');
    // A hand-written data object that TRIES to cast (the retired model's move):
    // both spellings are unknown to the schema, and zod strips unknown keys, so
    // the parsed value cannot carry them. This is the structural half of D5 —
    // the encounter side is not merely told not to cast, it CANNOT SPEAK it.
    const parsed = encounterDataSchema.parse({
      difficulty: 'medium',
      levelHint: '2',
      monsters: [
        {
          name: 'Goblin',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'rulebook', chunkId: crypto.randomUUID() },
          creatureRef: { chunkId: crypto.randomUUID() },
        },
      ],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      preset: 'standard',
      locationKind: 'dungeon',
      siteShape: 'single',
      budgetAdvisory: '',
      layout: null,
      creatureRef: { chunkId: crypto.randomUUID() },
      cast: true,
    });
    const serialized = JSON.stringify(parsed);
    expect(serialized).toContain('rulebook');
    expect(serialized).not.toContain('creatureRef');
    expect(serialized).not.toContain('"cast"');
  });

  it('resolving a citation never writes a library row (the tier is read-only)', async () => {
    const chunkId = await seedCreep('Bog Zombie', 22);
    const before = await db.chunks.count();
    await resolveCreatureCitation({ chunkId, creatureName: 'Bog Zombie' }, 'Bog Zombie');
    await resolveCreatureCitation({ chunkId: crypto.randomUUID() }, 'Absent');
    expect(await db.chunks.count()).toBe(before);
  });

  it('no module or campaign row is created by reading the library', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const chunkId = await seedCreep('Bog Zombie', 22);
    const battles = await db.battles.count();
    await resolveCreatureCitation({ chunkId }, 'Bog Zombie');
    expect(await listArtifactsByCampaign(campaign.id)).toEqual([]);
    expect(await db.battles.count()).toBe(battles);
    expect(await getBattleByModule('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });
});
