import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { getBattleByEncounter } from '@/db/battleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { castCreatureAsNpc } from '@/db/creatureRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { db } from '@/db/db';
import {
  contentCreatureKey,
  createModule,
  libraryCreatureKey,
  rosterEntryCreatureIdentity,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type AnyArtifact,
  type MonsterEntry,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { rosterParticipantRoute } from '@/features/campaign/mob-portrait-participants';
import { clearDatabase } from './helpers';

/**
 * ONE CREATURE IDENTITY, ONE SPELLING (docs/17 row 165).
 *
 * The owner's report: *"a mob in an encounter has no portrait on the battle
 * map, although the SAME mob shows its portrait on the module surface"* — a
 * module-level creature with core stats and a library portrait, whose battle
 * token showed initials while the module side showed its art, and whose
 * "Generate everything" affordance was ABSENT because nothing was missing as
 * far as the portrait batch could see.
 *
 * A token's portrait key (`BattleToken.creatureKey`, stamped by seeding), the
 * key the portrait batch writes the campaign's presentation row under, the
 * global cache key and the module gap detector's own reading are ONE fact.
 * They were four spellings of it: `db/battleSeed` computed the key in three
 * separate arms — a statless arm switching on `source.type`, the resolved
 * library listing for a statful citation, and the invented identity — while
 * `features/campaign/mob-portrait-participants.rosterParticipantRoute`
 * re-derived it for the batch and the detector. Every arm was correct where it
 * was written, and two of them DISAGREED with the portrait lane:
 *
 * - a citation the library healed by its content hash (a re-ingest) seeded
 *   `chunk:<the resolved row>` while the batch named `chunk:<the cited uuid>`;
 * - a `creatureRef` carrying only a content hash seeded the resolved row's key
 *   while the batch named the CAST ROW's content identity.
 *
 * What is pinned here is the COLLAPSE, not the two cases: every roster shape
 * seeds exactly the key `domain/creature.rosterEntryCreatureIdentity` answers,
 * the route the portrait lane rides answers the same key for the same row, and
 * the key is born in that ONE seam. The portrait the board renders is pinned by
 * `tests/features/creature-portrait-agreement.test.tsx`.
 */

let campaignId = '';

const ZOMBIE_TEXT = 'Zombie, undead. HP 22, AC 8.';
const DEAD_CHUNK_ID = '00000000-0000-4000-8000-0000000dead0';

function statBlock(): ReturnType<typeof statBlockSchema.parse> {
  return statBlockSchema.parse({
    system: 'dnd5e', level: '1', size: 'Medium', creatureType: 'undead',
    ac: 8, acNote: '', hp: 22, hpFormula: '', speed: '20 ft.',
    abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
    saves: '', skills: '', senses: '', languages: '', cr: '1/4', proficiency: 2,
    traits: [], actions: [], reactions: [], legendary: [], extras: {},
  });
}

beforeEach(async () => {
  await clearDatabase();
  campaignId = (await createCampaign({ name: 'One identity', system: 'dnd5e' })).id;
});

async function seedChunk(heading: string, text: string): Promise<string> {
  const book = await createRulebook({ title: 'Monster Core', system: 'dnd5e', filename: 'mc.pdf' });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(), bookId: book.id, pageStart: 1, pageEnd: 1, chunkType: 'statblock',
      headingPath: [heading], text, statBlock: statBlock(),
      contentHash: await sha256Hex(text),
    }),
  ]);
  const chunk = await db.chunks.where('bookId').equals(book.id).first();
  if (chunk === undefined) throw new Error('chunk missing');
  return chunk.id;
}

async function newModule(title: string): Promise<string> {
  const moduleRow = await saveModule(
    createModule({ campaignId, title, concept: '', levelMin: 1, levelMax: 5, sizeDial: 'sketch' }),
  );
  return moduleRow.id;
}

/** Seeds one encounter with `monsters`, seeds its battle, and answers the
 * seeded tokens plus the tokens' roster rows paired with their keys. */
async function seedAndRead(
  moduleId: string,
  monsters: MonsterEntry[],
): Promise<{ tokens: { label: string; creatureKey: string | undefined }[]; encounters: MonsterEntry[] }> {
  const encounter = await createArtifact({
    campaignId, moduleId, kind: 'encounter', name: 'E',
    data: {
      difficulty: 'medium', levelHint: '1', monsters, terrain: '', tactics: '', treasure: '',
      mapImageId: null, layout: null, preset: 'standard', locationKind: 'other',
      siteShape: 'single', budgetAdvisory: '',
    },
  });
  await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
  const battle = await getBattleByEncounter(encounter.id);
  const row = await db.artifacts.get(encounter.id);
  const data = row?.data;
  if (data === undefined || !('monsters' in data)) throw new Error('encounter data missing');
  return {
    tokens: (battle?.board.tokens ?? []).map((token) => ({
      label: token.label,
      creatureKey: token.creatureKey,
    })),
    encounters: data.monsters,
  };
}

async function artifactOf(entry: MonsterEntry): Promise<AnyArtifact | undefined> {
  return entry.source.type === 'npc-ref' ? db.artifacts.get(entry.source.artifactId) : undefined;
}

/** The key of the token this roster row seeded — its label is the entry's own
 * name for a single instance. */
function tokenKeyOf(
  tokens: { label: string; creatureKey: string | undefined }[],
  entry: MonsterEntry,
): string | undefined {
  return tokens.find((token) => token.label === entry.name)?.creatureKey;
}

describe('every roster shape seeds the key the portrait lane names', () => {
  it('a library citation, an invented mob, a cast creature and an authored npc agree', async () => {
    const chunkId = await seedChunk('Zombie', ZOMBIE_TEXT);
    const moduleId = await newModule('Shapes');
    const cast = await castCreatureAsNpc({
      campaignId, moduleId,
      citation: { chunkId, contentHash: await sha256Hex(ZOMBIE_TEXT), creatureName: 'Zombie' },
      name: 'Gustav the Zombie', prose: { body: 'The gardener, risen.' },
    });
    const authored = await createArtifact({
      campaignId, moduleId, kind: 'npc', name: 'Innkeeper',
      data: { appearance: '', personality: '', statBlock: statBlock() },
    });
    const { tokens, encounters } = await seedAndRead(moduleId, [
      { name: 'Zombie', count: 1, notes: '', treasure: '', source: { type: 'rulebook', chunkId } },
      { name: 'Bog Thing', count: 1, notes: 'Wet.', treasure: '', source: { type: 'inline', statBlock: statBlock() } },
      { name: 'Nameless Thing', count: 1, notes: 'Nothing at all.', treasure: '', source: { type: 'none' } },
      { name: 'Gustav the Zombie', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: cast.artifactId } },
      { name: 'Innkeeper', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: authored.id } },
    ]);

    // Non-vacuity: all five shapes really seeded a token.
    expect(tokens.map((token) => token.label).sort()).toEqual(
      ['Bog Thing', 'Gustav the Zombie', 'Innkeeper', 'Nameless Thing', 'Zombie'],
    );

    for (const entry of encounters) {
      const route = rosterParticipantRoute(entry, await artifactOf(entry));
      const identity = rosterEntryCreatureIdentity(entry, await artifactOf(entry));
      const seeded = tokenKeyOf(tokens, entry);
      if (route.lane === 'authored') {
        // An authored npc's portrait is its own cover: NO creature identity,
        // on the route and on the token alike.
        expect(seeded).toBeUndefined();
        expect(identity).toBeNull();
        continue;
      }
      expect(route.lane === 'invented' ? 'invented' : 'creature').toBeTypeOf('string');
      const routeKey = route.lane === 'creature' || route.lane === 'invented' ? route.creatureKey : null;
      expect(identity?.key).toBe(routeKey);
      expect(seeded).toBe(routeKey);
    }
  });

  it('a statless row carries the SAME key as the statful row of the same citation', async () => {
    // The citation names a chunk the library does not hold: the entry seeds a
    // token without stats — and that token still carries the creature identity
    // its citation names, which is the key the batch would write a portrait
    // under for the same citation.
    const moduleId = await newModule('Statless');
    const { tokens, encounters } = await seedAndRead(moduleId, [
      {
        name: 'Ghost Lumberjack', count: 1, notes: '', treasure: '',
        source: { type: 'rulebook', chunkId: DEAD_CHUNK_ID },
      },
    ]);
    const entry = encounters[0];
    if (entry === undefined) throw new Error('roster row missing');
    expect(tokens[0]?.creatureKey).toBe(libraryCreatureKey(DEAD_CHUNK_ID));
    expect(tokens[0]?.creatureKey).toBe(rosterEntryCreatureIdentity(entry, undefined)?.key);
  });

  it('a HEALED citation keys on the citation the roster row names — the same key the batch writes under', async () => {
    // A re-ingest landed the same bytes under a new row id: the stats resolve
    // through the content hash, and the portrait key stays the key the roster
    // row itself spells (`chunk:<the cited uuid>`) — the identity the batch's
    // own route answers, so the token and the portrait row cannot disagree.
    const liveChunkId = await seedChunk('Zombie', ZOMBIE_TEXT);
    expect(liveChunkId).not.toBe(DEAD_CHUNK_ID);
    const moduleId = await newModule('Healed');
    const { tokens, encounters } = await seedAndRead(moduleId, [
      {
        name: 'Zombie', count: 1, notes: '', treasure: '',
        source: {
          type: 'rulebook', chunkId: DEAD_CHUNK_ID,
          contentHash: await sha256Hex(ZOMBIE_TEXT), creatureName: 'Zombie', bookTitle: 'Monster Core',
        },
      },
    ]);
    const entry = encounters[0];
    if (entry === undefined) throw new Error('roster row missing');
    // The stats DID heal (the token has HP through the resolved row).
    expect(tokens[0]?.label).toBe('Zombie');
    expect(tokens[0]?.creatureKey).toBe(libraryCreatureKey(DEAD_CHUNK_ID));
    expect(tokens[0]?.creatureKey).toBe(rosterEntryCreatureIdentity(entry, undefined)?.key);
    expect(rosterParticipantRoute(entry, undefined)).toMatchObject({
      lane: 'creature',
      creatureKey: libraryCreatureKey(DEAD_CHUNK_ID),
    });
  });

  it('a cast creature whose citation carries only a content hash keys on its own row, both sides', async () => {
    const chunkId = await seedChunk('Zombie', ZOMBIE_TEXT);
    const moduleId = await newModule('Hash only');
    const cast = await castCreatureAsNpc({
      campaignId, moduleId,
      citation: { chunkId, contentHash: await sha256Hex(ZOMBIE_TEXT), creatureName: 'Zombie' },
      name: 'Gustav the Zombie', prose: { body: 'The gardener, risen.' },
    });
    // The stranded shape: a ref with no chunk uuid at all.
    await db.artifacts.update(cast.artifactId, {
      data: {
        appearance: '', personality: '', statBlock: null,
        creatureRef: { contentHash: await sha256Hex(ZOMBIE_TEXT), creatureName: 'Zombie' },
      },
    });
    const { tokens, encounters } = await seedAndRead(moduleId, [
      { name: 'Gustav the Zombie', count: 1, notes: '', treasure: '', source: { type: 'npc-ref', artifactId: cast.artifactId } },
    ]);
    const entry = encounters[0];
    if (entry === undefined) throw new Error('roster row missing');
    expect(tokens[0]?.creatureKey).toBe(contentCreatureKey('Gustav the Zombie', undefined));
    expect(tokens[0]?.creatureKey).toBe(rosterEntryCreatureIdentity(entry, await artifactOf(entry))?.key);
    expect(rosterParticipantRoute(entry, await artifactOf(entry))).toMatchObject({
      lane: 'creature',
      creatureKey: contentCreatureKey('Gustav the Zombie', undefined),
    });
  });
});
