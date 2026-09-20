import 'fake-indexeddb/auto';

import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import { battleSchema, contentCreatureKey, foldCreatureKey, newId, type Battle } from '@/domain';

/**
 * THE PERSISTED CREATURE KEY IS FOLDED (docs/17 row 168).
 *
 * `contentCreatureKey` used to mint `content:${JSON.stringify([
 * name.trim().toLowerCase(), statBlock ?? null])}` — no Unicode canonical
 * folding — and that STRING is an existing identity: a UNIQUE
 * `mobPortraits.creatureKey`, a `creatureImages` composite index, and every
 * battle key. A Mac-authored (NFD) and a precomposed (NFC) spelling of one name
 * therefore minted DIFFERENT keys: two portrait slots for one creature, and
 * "one creature, one look" (docs/11 D6) broken silently.
 *
 * The mint folds now, and Dexie version 22 re-keys the stored bytes through the
 * SAME `foldCreatureKey` seam `lib/exportImport` uses. These tests seed a REAL
 * version-21 database with decomposed keys and open it at v22.
 *
 * The fixtures block first proves composed and decomposed really are different
 * bytes, so no pin here can pass vacuously.
 */

const COMPOSED = 'Wächter'; // precomposed ä (U+00E4)
const DECOMPOSED = 'Wa\u0308chter'; // a + combining diaeresis (U+0308)

const CAMPAIGN = '00000000-0000-4000-8000-0000000000c1';
const MODULE = '00000000-0000-4000-8000-0000000000d1';
const CHUNK = '00000000-0000-4000-8000-0000000000a1';

/** The PRE-FOLD mint (docs/17 row 167: `name.trim().toLowerCase()`, no NFC) —
 * what a row written by the shipped app holds before this slice. */
function legacyContentKey(name: string, statBlock: unknown): string {
  return `content:${JSON.stringify([name.trim().toLowerCase(), statBlock ?? null])}`;
}

/** One schema-valid battle row carrying the legacy key on every creature-key
 * carrier a battle row has (board token, saved stage token, frozen fighter),
 * plus one `chunk:` token that must survive byte-identical. */
function legacyBattle(): Battle {
  const token = (): Record<string, unknown> => ({
    id: newId(),
    artifactId: null,
    label: 'Wächter',
    x: 0.5,
    y: 0.5,
    visible: true,
    scale: 1,
    shape: 'circle' as const,
    color: null,
    currentHp: null,
    initiativeRoll: null,
    initiativeBonus: null,
  });
  return battleSchema.parse({
    id: newId(),
    createdAt: 1,
    updatedAt: 1,
    campaignId: CAMPAIGN,
    moduleId: MODULE,
    encounterArtifactId: null,
    reseed: null,
    board: {
      tokens: [
        { ...token(), creatureKey: legacyContentKey(DECOMPOSED, null) },
        { ...token(), creatureKey: `chunk:${CHUNK}` },
      ],
      stage: {
        tokens: [{ ...token(), creatureKey: legacyContentKey(DECOMPOSED, { ac: 9 }) }],
      },
    },
    seedFighters: [
      {
        id: newId(),
        name: 'Wächter',
        maxHp: 7,
        initiativeBonus: 1,
        creatureKey: legacyContentKey(DECOMPOSED, null),
      },
    ],
  });
}

/** The v21 schema, copied verbatim from `src/db/db.ts`'s `version(21)` block. */
async function seedLegacyV21(seed: (legacy: Dexie) => Promise<void>): Promise<void> {
  await Dexie.delete('campaigner');
  const legacy = new Dexie('campaigner');
  legacy.version(21).stores({
    campaigns: 'id, name',
    artifacts: 'id, campaignId, kind, [campaignId+kind], name, updatedAt, moduleId, [moduleId+kind]',
    revisions: 'id, artifactId, [artifactId+revision]',
    images: 'id, campaignId',
    rulebooks: 'id, system, status',
    chunks: 'id, bookId, chunkType, contentHash',
    embeddings: 'contentHash',
    personas: 'id, &slug',
    runs: 'id, campaignId, personaId, status, updatedAt',
    deliverables: null,
    modules: 'id, campaignId, updatedAt',
    battles: 'id, campaignId, &moduleId',
    pdfFiles: 'id, &bookId',
    mobPortraits: 'id, &creatureKey',
    moduleVersions: 'id, moduleId, createdAt',
    creatureImages: 'id, campaignId, [campaignId+creatureKey]',
    settings: 'id',
  });
  await legacy.open();
  await legacy.table('settings').put({ id: 'settings' });
  await seed(legacy);
  legacy.close();
}

describe('the fixtures really are two spellings of one name', () => {
  it('composed and decomposed differ as bytes and agree only under the comparable form', () => {
    expect(COMPOSED).not.toBe(DECOMPOSED);
    expect(DECOMPOSED.normalize('NFC')).toBe(COMPOSED);
    expect(legacyContentKey(COMPOSED, null)).not.toBe(legacyContentKey(DECOMPOSED, null));
    expect(foldCreatureKey(legacyContentKey(DECOMPOSED, null))).toBe(
      contentCreatureKey(COMPOSED, null),
    );
  });
});

describe('foldCreatureKey — the migration/import seam (docs/17 row 168)', () => {
  it('folds a key minted from composed OR decomposed input to itself', () => {
    for (const name of [COMPOSED, DECOMPOSED]) {
      const key = contentCreatureKey(name, { ac: 12 });
      expect(foldCreatureKey(key)).toBe(key);
    }
  });

  it('is idempotent, and folds a legacy decomposed key onto the new mint', () => {
    const legacy = legacyContentKey(DECOMPOSED, { ac: 12 });
    const folded = foldCreatureKey(legacy);
    expect(folded).toBe(contentCreatureKey(DECOMPOSED, { ac: 12 }));
    expect(foldCreatureKey(folded)).toBe(folded);
  });

  it('a content: key minted from an ALREADY-NFC name is byte-identical before and after the fold', () => {
    // This is why the migration is a no-op for typical data: a precomposed
    // name's old key already equals its new key.
    const legacy = legacyContentKey(COMPOSED, null);
    expect(legacy).toBe(contentCreatureKey(COMPOSED, null));
    expect(foldCreatureKey(legacy)).toBe(legacy);
  });

  it('returns chunk:, artifact: and every other key space UNCHANGED', () => {
    for (const key of [`chunk:${CHUNK}`, `artifact:${CHUNK}`, 'other:thing', '']) {
      expect(foldCreatureKey(key)).toBe(key);
    }
  });

  it('throws LOUDLY for a content: key it cannot parse — never silently keeps it', () => {
    expect(() => foldCreatureKey('content:not-json')).toThrow(
      /cannot fold a content: key that is not JSON/,
    );
    expect(() => foldCreatureKey('content:{"a":1}')).toThrow(
      /cannot fold a content: key that is not a \[name, statBlock\] pair/,
    );
    expect(() => foldCreatureKey('content:[1,2]')).toThrow(
      /cannot fold a content: key that is not a \[name, statBlock\] pair/,
    );
  });
});

describe('v21 → v22 migration (the persisted creature key is folded)', () => {
  it('re-keys decomposed rows and battle keys, reports the counts, and leaves chunk: bytes alone', async () => {
    await seedLegacyV21(async (legacy) => {
      await legacy.table('mobPortraits').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 1,
        creatureKey: legacyContentKey(DECOMPOSED, null),
        imageId: newId(),
      });
      await legacy.table('mobPortraits').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 1,
        creatureKey: `chunk:${CHUNK}`,
        imageId: newId(),
      });
      await legacy.table('creatureImages').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 1,
        campaignId: CAMPAIGN,
        creatureKey: legacyContentKey(DECOMPOSED, { ac: 12 }),
        imageId: newId(),
      });
      await legacy.table('battles').put(legacyBattle());
    });

    const { db } = await import('@/db/db');
    await db.open();
    // Head of the chain: v22 is the fold this suite pins; the later versions (v23
    // the Idea Board, v24 the mob copy, v25 the encounter-owned battle, v26 the
    // library-artifact adoption, v27 the battle-token adoption, v28 the seeding-encounter naming) are additive and
    // touch no creature state.
    expect(db.verno).toBe(29);

    // 1. The portrait slot is found under the FOLDED key, and the legacy bytes
    //    are gone from the unique index.
    const foldedPortraitKey = contentCreatureKey(DECOMPOSED, null);
    const portrait = await db.mobPortraits.where('creatureKey').equals(foldedPortraitKey).first();
    expect(portrait).toBeDefined();
    expect(
      await db.mobPortraits.where('creatureKey').equals(legacyContentKey(DECOMPOSED, null)).count(),
    ).toBe(0);
    //    The chunk-keyed slot is byte-identical (an id, not a name).
    const chunkPortrait = await db.mobPortraits
      .where('creatureKey')
      .equals(`chunk:${CHUNK}`)
      .first();
    expect(chunkPortrait?.creatureKey).toBe(`chunk:${CHUNK}`);

    // 2. The campaign presentation row is found under the folded key.
    const foldedImageKey = contentCreatureKey(DECOMPOSED, { ac: 12 });
    expect(
      await db.creatureImages
        .where('[campaignId+creatureKey]')
        .equals([CAMPAIGN, foldedImageKey])
        .count(),
    ).toBe(1);
    expect(
      await db.creatureImages
        .where('[campaignId+creatureKey]')
        .equals([CAMPAIGN, legacyContentKey(DECOMPOSED, { ac: 12 })])
        .count(),
    ).toBe(0);

    // 3. Every creature key inside the battle row is folded — the board token,
    //    the saved stage snapshot's token and the frozen seed fighter — while
    //    the chunk: token is byte-identical.
    const battle = await db.battles.toCollection().first();
    if (battle === undefined) throw new Error('the seeded battle did not survive the upgrade');
    expect(battle.board.tokens[0]?.creatureKey).toBe(foldedPortraitKey);
    expect(battle.board.tokens[1]?.creatureKey).toBe(`chunk:${CHUNK}`);
    expect(battle.board.stage?.tokens[0]?.creatureKey).toBe(
      contentCreatureKey(DECOMPOSED, { ac: 9 }),
    );
    expect(battle.seedFighters[0]?.creatureKey).toBe(foldedPortraitKey);
    //    and the migrated row still parses against the current schema.
    expect(battleSchema.parse(battle).board.tokens[0]?.creatureKey).toBe(foldedPortraitKey);

    // 4. The counts are LOUD and per population (read once by AppShell).
    const settings = await db.settings.get('settings');
    expect(settings?.creatureKeyFold).toEqual({
      mobPortraitKeysFolded: 1,
      creatureImageKeysFolded: 1,
      battleTokenKeysFolded: 2,
      seedFighterKeysFolded: 1,
      mergedRows: 0,
      dropped: [],
    });

    await db.delete();
  }, 20000);

  it('keeps the NEWER updatedAt when a creature exists under BOTH compositions, and records the drop', async () => {
    const keptPortraitImage = newId();
    const droppedPortraitImage = newId();
    const keptImageImage = newId();
    const droppedImageImage = newId();
    await seedLegacyV21(async (legacy) => {
      // The composed row is NEWER and must win; the decomposed one is dropped.
      await legacy.table('mobPortraits').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 2000,
        creatureKey: contentCreatureKey(COMPOSED, null),
        imageId: keptPortraitImage,
      });
      await legacy.table('mobPortraits').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 1000,
        creatureKey: legacyContentKey(DECOMPOSED, null),
        imageId: droppedPortraitImage,
      });
      // The decomposed presentation row is NEWER and must win; the composed one
      // is dropped.
      await legacy.table('creatureImages').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 1000,
        campaignId: CAMPAIGN,
        creatureKey: contentCreatureKey(COMPOSED, { ac: 9 }),
        imageId: droppedImageImage,
      });
      await legacy.table('creatureImages').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 2000,
        campaignId: CAMPAIGN,
        creatureKey: legacyContentKey(DECOMPOSED, { ac: 9 }),
        imageId: keptImageImage,
      });
    });

    const { db } = await import('@/db/db');
    await db.open();

    const portraits = await db.mobPortraits.toArray();
    expect(portraits).toHaveLength(1);
    expect(portraits[0]?.creatureKey).toBe(contentCreatureKey(COMPOSED, null));
    expect(portraits[0]?.imageId).toBe(keptPortraitImage);

    const images = await db.creatureImages.toArray();
    expect(images).toHaveLength(1);
    expect(images[0]?.creatureKey).toBe(contentCreatureKey(COMPOSED, { ac: 9 }));
    expect(images[0]?.imageId).toBe(keptImageImage);

    const settings = await db.settings.get('settings');
    expect(settings?.creatureKeyFold).toEqual({
      // The composed portrait already held the folded key; the composed
      // presentation row did NOT (the decomposed one won and was re-keyed).
      mobPortraitKeysFolded: 0,
      creatureImageKeysFolded: 1,
      battleTokenKeysFolded: 0,
      seedFighterKeysFolded: 0,
      mergedRows: 2,
      dropped: [
        {
          table: 'mobPortraits',
          creatureKey: legacyContentKey(DECOMPOSED, null),
          imageId: droppedPortraitImage,
        },
        {
          table: 'creatureImages',
          creatureKey: contentCreatureKey(COMPOSED, { ac: 9 }),
          imageId: droppedImageImage,
        },
      ],
    });

    await db.delete();
  }, 20000);

  it('breaks an updatedAt TIE toward the row already stored under the folded key (deterministic)', async () => {
    const composedImage = newId();
    await seedLegacyV21(async (legacy) => {
      await legacy.table('mobPortraits').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 1000,
        creatureKey: legacyContentKey(DECOMPOSED, null),
        imageId: newId(),
      });
      await legacy.table('mobPortraits').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 1000,
        creatureKey: contentCreatureKey(COMPOSED, null),
        imageId: composedImage,
      });
    });

    const { db } = await import('@/db/db');
    await db.open();
    const portraits = await db.mobPortraits.toArray();
    expect(portraits).toHaveLength(1);
    expect(portraits[0]?.imageId).toBe(composedImage);
    expect((await db.settings.get('settings'))?.creatureKeyFold?.mergedRows).toBe(1);
    await db.delete();
  }, 20000);

  it('fails LOUDLY when a content: key cannot be folded — never silently kept', async () => {
    await seedLegacyV21(async (legacy) => {
      await legacy.table('mobPortraits').put({
        id: newId(),
        createdAt: 1,
        updatedAt: 1,
        creatureKey: 'content:not-json',
        imageId: newId(),
      });
    });

    const { db } = await import('@/db/db');
    const rejection = await db.open().then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toContain('cannot fold a content: key that is not JSON');

    // Clean up the half-migrated (aborted) database so a rerun starts clean.
    await Dexie.delete('campaigner');
  }, 20000);
});
