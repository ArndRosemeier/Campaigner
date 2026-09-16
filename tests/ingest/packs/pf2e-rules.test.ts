import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PackMeta } from '@/domain/rulebook';
import type { RuleChunk } from '@/domain';
import { importPack, type PackImportDeps } from '@/ingest/packImport';
import {
  FOUNDRY_PF2E_RULES_ADAPTER_ID,
  foundryPf2eRulesAdapter,
  headingCategoriesFor,
} from '@/ingest/packs/pf2e-rules';
import { getPackAdapter, PACK_ADAPTERS } from '@/ingest/packs/registry';
import type { PackSectionEntry } from '@/ingest/packs/types';
import { sha256Hex } from '@/lib/hash';

import { baseNpc, encodeJson, folderDoc } from './fixtures';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'packs', 'pf2e-rules');

/**
 * `foundry-pf2e-rules` adapter tests (docs/12 §15): fixtures are REAL
 * upstream documents at v14-dev — two feats (Cat Fall, Armor Proficiency),
 * one spell (Acid Splash, the OGL/legacy shape) and one action (Aid),
 * trimmed to the consumed subset plus identity keys. Pins: the folder-path →
 * heading mapping, the per-type summary lines, the per-entry `publication` →
 * `Source:` line (ORC AND OGL), loud failures, and the importPack lane.
 */

/** Verbatim live sources (docs/12 §10 lesson — no invented shapes). */
const SOURCE_PATHS: Readonly<Record<string, string>> = {
  'cat-fall.json': 'packs/pf2e/feats/skill/level-1/cat-fall.json @ v14-dev',
  'armor-proficiency.json': 'packs/pf2e/feats/general/level-1/armor-proficiency.json @ v14-dev',
  'acid-splash.json': 'packs/pf2e/spells/spells/cantrip/acid-splash.json @ v14-dev',
  'aid.json': 'packs/pf2e/actions/basic/aid.json @ v14-dev',
};

function docBytes(name: string): Uint8Array {
  return new TextEncoder().encode(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

/** The fixture parsed as a raw source document (what the adapter read). */
function fixtureSource(name: string): { system: { heightening: unknown } } {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as {
    system: { heightening: unknown };
  };
}

/** A minimal synthetic spell document, for shapes no real fixture carries. */
function syntheticSpellBytes(description: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      name: 'Synthetic Bolt',
      type: 'spell',
      system: {
        description: { value: description },
        traits: { value: ['attack'], rarity: 'common', traditions: ['arcane'] },
        level: { value: 2 },
        time: { value: '2' },
        range: { value: '60 feet' },
        target: { value: '1 creature' },
        duration: { value: '' },
      },
    }),
  );
}

/** Paths mirror the upstream folder layout — the fetch keeps them relative to packs/pf2e. */
async function parseAs(name: string, packRelative: string): Promise<PackSectionEntry> {
  const parsed = await foundryPf2eRulesAdapter.parseFile(packRelative, docBytes(name));
  expect(parsed.failures).toEqual([]);
  const sections = parsed.sections ?? [];
  expect(sections, `${name} must yield exactly one section entry`).toHaveLength(1);
  const section = sections[0];
  if (section === undefined) throw new Error(`unreachable: ${name} asserted to have one section`);
  return section;
}

type MemoryDeps = PackImportDeps & {
  created: { title: string; system: string; filename: string }[];
  persisted: RuleChunk[][];
  finalized: { id: string; packMeta: PackMeta | null }[];
  failed: { id: string; message: string }[];
};

function memoryDeps(): MemoryDeps {
  const created: { title: string; system: string; filename: string }[] = [];
  const persisted: RuleChunk[][] = [];
  const finalized: { id: string; packMeta: PackMeta | null }[] = [];
  const failed: { id: string; message: string }[] = [];
  const deps: MemoryDeps = {
    createBook: (input) => {
      created.push(input);
      const id = crypto.randomUUID();
      return Promise.resolve({
        id,
        createdAt: 1,
        updatedAt: 1,
        title: input.title,
        system: input.system,
        filename: input.filename,
        pageCount: 0,
        status: 'processing',
        errorMessage: '',
        origin: 'pack',
        packMeta: null,
      });
    },
    persistChunks: (chunks) => {
      persisted.push(chunks);
      return Promise.resolve();
    },
    finalizeBook: (id, packMeta) => {
      finalized.push({ id, packMeta });
      return Promise.resolve({
        id,
        createdAt: 1,
        updatedAt: 1,
        title: id,
        system: 'pathfinder2e',
        filename: 'pack.json',
        pageCount: 0,
        status: 'ready',
        errorMessage: '',
        origin: 'pack',
        packMeta,
      });
    },
    failBook: (id, message) => {
      failed.push({ id, message });
      return Promise.resolve();
    },
    created,
    persisted,
    finalized,
    failed,
  };
  return deps;
}

describe('foundry-pf2e-rules adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never touches the network (12-BESTIARY-PACKS §9/§10)', async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('adapters must never fetch');
    });
    vi.stubGlobal('fetch', fetchSpy);
    await parseAs('cat-fall.json', 'feats/skill/level-1/cat-fall.json');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is registered with the rule entry noun and the volume-labelled source name', () => {
    expect(getPackAdapter(FOUNDRY_PF2E_RULES_ADAPTER_ID).id).toBe(FOUNDRY_PF2E_RULES_ADAPTER_ID);
    expect(PACK_ADAPTERS.map((adapter) => adapter.entryNoun)).toContain('rule');
    // The opt-in story is visible in the card before any fetch (docs/12 §15).
    expect(foundryPf2eRulesAdapter.label).toContain('feats 6,284');
    expect(foundryPf2eRulesAdapter.label).toContain('spells 1,994');
    expect(foundryPf2eRulesAdapter.license).toContain('ORC or OGL');
    expect(foundryPf2eRulesAdapter.license).toContain('not for redistribution');
  });

  it('maps the real Cat Fall (skill feat) with the folder-path heading and prerequisites', async () => {
    const entry = await parseAs('cat-fall.json', 'feats/skill/level-1/cat-fall.json');
    expect(SOURCE_PATHS['cat-fall.json']).toContain('feats/skill');
    expect(entry.categories).toEqual(['Feats — Skill', 'Level 1']);
    expect(entry.name).toBe('Cat Fall');
    // Non-spell entries carry no structured payload: the runner keeps them
    // `section` chunks, exactly as before the spells arc.
    expect(entry.spell).toBeUndefined();
    expect(entry.text).toContain('Cat Fall');
    expect(entry.text).toContain('Feat 1 (general, skill)');
    expect(entry.text).toContain('Prerequisites: trained in Acrobatics');
    expect(entry.text).toContain('Treat falls as 10 feet shorter');
    expect(entry.text).toContain('Source: Pathfinder Player Core (ORC)');
    expect(entry.text).not.toMatch(/<[^>]+>/);
  });

  it('maps the real Armor Proficiency (general feat, Special clause, no prerequisites line)', async () => {
    const entry = await parseAs('armor-proficiency.json', 'feats/general/level-1/armor-proficiency.json');
    expect(entry.categories).toEqual(['Feats — General', 'Level 1']);
    expect(entry.name).toBe('Armor Proficiency');
    expect(entry.text).toContain('You become trained in light armor.');
    expect(entry.text).toContain('Special You can select this feat more than once.');
    expect(entry.text).not.toContain('Prerequisites:');
    expect(entry.text).toContain('Source: Pathfinder Player Core (ORC)');
  });

  it('maps the real Acid Splash (cantrip spell) with the OGL legacy source line AND its structured payload', async () => {
    const entry = await parseAs('acid-splash.json', 'spells/spells/cantrip/acid-splash.json');
    expect(entry.categories).toEqual(['Spells — Cantrip']);
    expect(entry.name).toBe('Acid Splash');
    expect(entry.text).toContain('Cantrip 1 (acid, attack, cantrip, concentrate, manipulate) arcane, primal');
    expect(entry.text).toContain('Cast 2 · 30 feet · 1 creature');
    expect(entry.text).toContain('You splash a glob of acid');
    // The legacy spell documents OGL + Core Rulebook — verbatim per-entry.
    expect(entry.text).toContain('Source: Pathfinder Core Rulebook (OGL)');
    // The SAME mapping emits the structured half (the spells arc): the source
    // stores this cantrip at level 1, so `rank: 0` is the deliberate list
    // normalization (cantrips lead a level-sorted list); the text is untouched.
    // `cantrip` is the TRAIT signal. Heightening is captured two ways: the
    // source's own `system.heightening` VERBATIM (deep-equal to the fixture's)
    // and the four notes parsed from the raw description, in document order.
    expect(entry.spell).toEqual({
      system: 'pathfinder2e',
      rank: 0,
      cantrip: true,
      traditions: ['arcane', 'primal'],
      traits: ['acid', 'attack', 'cantrip', 'concentrate', 'manipulate'],
      rarity: 'common',
      cast: { time: '2', range: '30 feet', target: '1 creature', duration: '' },
      // Ledger 183: the base numbers the heightening rule combines against —
      // the source's own `system.damage` record (keys preserved) and `area`.
      damage: {
        '0': { formula: '1d6', type: 'acid', category: null, materials: [] },
        gcovwqxwitqchoin: { formula: '1', type: 'acid', category: 'splash', materials: [] },
      },
      area: null,
      heightening: fixtureSource('acid-splash.json').system.heightening,
      heighteningEntries: [
        {
          kind: 'fixed',
          rank: 3,
          text: 'The initial damage increases to 2d6, and the persistent damage increases to 2.',
        },
        {
          kind: 'fixed',
          rank: 5,
          text: 'The initial damage increases to 3d6, the persistent damage increases to 3, and the splash damage increases to 2.',
        },
        {
          kind: 'fixed',
          rank: 7,
          text: 'The initial damage increases to 4d6, the persistent damage increases to 4, and the splash damage increases to 3.',
        },
        {
          kind: 'fixed',
          rank: 9,
          text: 'The initial damage increases to 5d6, the persistent damage increases to 5, and the splash damage increases to 4.',
        },
      ],
      heighteningUnparsed: [],
      publication: { title: 'Pathfinder Core Rulebook', license: 'OGL' },
    });
  });

  it('parses an INCREMENT heightening heading into a structured note', async () => {
    const parsed = await foundryPf2eRulesAdapter.parseFile(
      'spells/spells/rank-2/synthetic-bolt.json',
      syntheticSpellBytes(
        '<p>Base text.</p><p><strong>Heightened (+1)</strong> The damage increases by 1d6.</p>',
      ),
    );
    expect(parsed.failures).toEqual([]);
    const entry = (parsed.sections ?? [])[0];
    expect(entry?.spell?.cantrip).toBe(false);
    expect(entry?.spell?.rank).toBe(2);
    expect(entry?.spell?.heightening).toBeNull();
    expect(entry?.spell?.heighteningEntries).toEqual([
      { kind: 'increment', increment: 1, text: 'The damage increases by 1d6.' },
    ]);
    expect(entry?.spell?.heighteningUnparsed).toEqual([]);
  });

  it('captures an unrecognized Heightened line as LOUD unparsed data (never dropped)', async () => {
    const parsed = await foundryPf2eRulesAdapter.parseFile(
      'spells/spells/rank-2/synthetic-bolt.json',
      syntheticSpellBytes(
        '<p>Base text.</p>\n<p><strong>Heightened (special)</strong> Something unusual.</p>',
      ),
    );
    expect(parsed.failures).toEqual([]);
    const entry = (parsed.sections ?? [])[0];
    expect(entry?.spell?.heighteningEntries).toEqual([]);
    expect(entry?.spell?.heighteningUnparsed).toEqual([
      '<p><strong>Heightened (special)</strong> Something unusual.</p>',
    ]);
  });

  it('keeps every emitted text byte-identical to the arc base (the text IS the contentHash)', async () => {
    // MEASURED at c07e625 (the arc's base) through this same adapter: the
    // sha256 of each emitted text. Adding `spellData` must not move a byte —
    // the text is the stored `contentHash` and a change would invalidate every
    // stored citation (docs/12 §15, ledger 181).
    const baseTextHashes: Readonly<Record<string, string>> = {
      'cat-fall.json': '1938ab47dee67695d071142aa8317dea6f8596df5d435f287e11ea09be2fea9d',
      'armor-proficiency.json': '24ba68157a7342411216143d8004d2523ece801ca3a50101cf2101468812d21e',
      'acid-splash.json': 'be199c4153818e5e71ca51f06da169adf65a3635a5a433184c463175eeb57eba',
      'aid.json': '5601cf771b0df10e515b2ce44b30e8d7bb9f22df00779a9291c0a5ea3ea6cad5',
    };
    const files: [string, string][] = [
      ['cat-fall.json', 'feats/skill/level-1/cat-fall.json'],
      ['armor-proficiency.json', 'feats/general/level-1/armor-proficiency.json'],
      ['acid-splash.json', 'spells/spells/cantrip/acid-splash.json'],
      ['aid.json', 'actions/basic/aid.json'],
    ];
    for (const [fixture, fileName] of files) {
      const entry = await parseAs(fixture, fileName);
      expect(await sha256Hex(entry.text), `${fixture} text drifted from the arc base`).toBe(
        baseTextHashes[fixture],
      );
    }
  });

  it('maps the real Aid (reaction action) with the action-type summary', async () => {
    const entry = await parseAs('aid.json', 'actions/basic/aid.json');
    expect(entry.categories).toEqual(['Actions — Basic']);
    expect(entry.name).toBe('Aid');
    expect(entry.text).toContain('Reaction');
    expect(entry.text).toContain('Trigger An ally is about to use an action');
  });

  it('derives heading categories from the folder walk for every layout shape', () => {
    const feat = { type: 'feat', system: { category: 'skill' } } as const;
    const spell = { type: 'spell', system: { category: null } } as const;
    const classFeature = { type: 'feat', system: { category: 'classfeature' } } as const;
    expect(headingCategoriesFor(feat, 'feats/skill/level-1/cat-fall.json')).toEqual([
      'Feats — Skill',
      'Level 1',
    ]);
    // The pack folder never repeats: spells/spells/cantrip/… → Spells — Cantrip.
    expect(headingCategoriesFor(spell, 'spells/spells/cantrip/acid-splash.json')).toEqual([
      'Spells — Cantrip',
    ]);
    expect(headingCategoriesFor(spell, 'spells/spells/rank-2/fireball.json')).toEqual([
      'Spells — Rank 2',
    ]);
    expect(headingCategoriesFor(spell, 'spells/focus/grave-calls.json')).toEqual([
      'Spells — Focus',
    ]);
    // Flat class-features files carry the lane alone; per-class folders name it.
    expect(headingCategoriesFor(classFeature, 'class-features/abundant-vials.json')).toEqual([
      'Class Features',
    ]);
    expect(headingCategoriesFor(classFeature, 'class-features/magus/arcane-cascade.json')).toEqual([
      'Class Features — Magus',
    ]);
    // Loose manual imports fall back to the document type + own category.
    expect(headingCategoriesFor(feat, 'cat-fall.json')).toEqual(['Feats — Skill']);
  });

  it('skips non-entity documents and fails broken ones loudly', async () => {
    const ndjson = [
      JSON.stringify(folderDoc()),
      JSON.stringify(baseNpc('Goblin Warrior')),
      JSON.stringify({ type: 'feat', system: {} }), // no name → loud failure
    ].join('\n');
    const parsed = await foundryPf2eRulesAdapter.parseFile('feats/mixed.db', new TextEncoder().encode(ndjson));
    expect(parsed.entries).toEqual([]);
    expect(parsed.sections ?? []).toEqual([]);
    expect(parsed.skipped).toBe(2); // the Folder doc and the NPC doc
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]).toMatchObject({ file: 'feats/mixed.db', name: '' });
    expect(parsed.failures[0]?.message).toContain('document 2:');
  });

  it('imports into a ready book of `section` and `spell` chunks with the lanes counted in packMeta', async () => {
    const deps = memoryDeps();
    const result = await importPack(
      FOUNDRY_PF2E_RULES_ADAPTER_ID,
      [
        { name: 'feats/skill/level-1/cat-fall.json', bytes: docBytes('cat-fall.json') },
        { name: 'feats/general/level-1/armor-proficiency.json', bytes: docBytes('armor-proficiency.json') },
        { name: 'spells/spells/cantrip/acid-splash.json', bytes: docBytes('acid-splash.json') },
        { name: 'actions/basic/aid.json', bytes: docBytes('aid.json') },
      ],
      { title: 'PF2e Rules Text (sample)', deps },
    );
    expect(result.imported).toBe(4);
    expect(result.sectionsImported).toBe(4);
    expect(result.book.status).toBe('ready');
    const chunks = deps.persisted.flat();
    // The spell document is the ONE `spell` chunk; every other rules-text
    // entry keeps the `section` chunk it always was.
    expect(chunks.map((chunk) => chunk.chunkType)).toEqual([
      'section',
      'section',
      'spell',
      'section',
    ]);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ['Feats — Skill', 'Level 1', 'Cat Fall'],
      ['Feats — General', 'Level 1', 'Armor Proficiency'],
      ['Spells — Cantrip', 'Acid Splash'],
      ['Actions — Basic', 'Aid'],
    ]);
    expect(chunks[0]?.statBlock).toBeNull();
    expect('itemData' in (chunks[0] ?? {})).toBe(false);
    expect('spellData' in (chunks[0] ?? {})).toBe(false);
    expect(chunks[2]?.spellData?.rank).toBe(0);
    expect(chunks[2]?.spellData?.traditions).toEqual(['arcane', 'primal']);
    expect(deps.finalized[0]?.packMeta).toMatchObject({
      sourceId: FOUNDRY_PF2E_RULES_ADAPTER_ID,
      entriesImported: 4,
      itemsImported: 0,
      sectionsImported: 4,
    });
  });

  it('fails the book loudly naming the rule noun when nothing validates', async () => {
    const deps = memoryDeps();
    await expect(
      importPack(
        FOUNDRY_PF2E_RULES_ADAPTER_ID,
        [{ name: 'feats/_folders.json', bytes: encodeJson(folderDoc()) }],
        { title: 'Feats', deps },
      ),
    ).rejects.toThrow(/no valid rule entries in the pack selection/s);
    expect(deps.failed).toHaveLength(1);
    expect(deps.finalized).toHaveLength(0);
  });
});
