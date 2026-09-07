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

  it('maps the real Acid Splash (cantrip spell) with the OGL legacy source line', async () => {
    const entry = await parseAs('acid-splash.json', 'spells/spells/cantrip/acid-splash.json');
    expect(entry.categories).toEqual(['Spells — Cantrip']);
    expect(entry.name).toBe('Acid Splash');
    expect(entry.text).toContain('Cantrip 1 (acid, attack, cantrip, concentrate, manipulate) arcane, primal');
    expect(entry.text).toContain('Cast 2 · 30 feet · 1 creature');
    expect(entry.text).toContain('You splash a glob of acid');
    // The legacy spell documents OGL + Core Rulebook — verbatim per-entry.
    expect(entry.text).toContain('Source: Pathfinder Core Rulebook (OGL)');
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

  it('imports into a ready book of `section` chunks with the lanes counted in packMeta', async () => {
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
    expect(chunks.map((chunk) => chunk.chunkType)).toEqual(['section', 'section', 'section', 'section']);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ['Feats — Skill', 'Level 1', 'Cat Fall'],
      ['Feats — General', 'Level 1', 'Armor Proficiency'],
      ['Spells — Cantrip', 'Acid Splash'],
      ['Actions — Basic', 'Aid'],
    ]);
    expect(chunks[0]?.statBlock).toBeNull();
    expect('itemData' in (chunks[0] ?? {})).toBe(false);
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
