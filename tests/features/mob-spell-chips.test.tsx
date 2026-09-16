import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { putChunks } from '@/db/chunkRepo';
import { createPackBook, finalizePackBook } from '@/db/rulebookRepo';
import {
  ruleChunkSchema,
  spellDataSchema,
  stampNewEntity,
  statBlockSchema,
  type Id,
  type RuleChunk,
  type SpellData,
  type StatBlock,
} from '@/domain';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import { foundryPf2eAdapter } from '@/ingest/packs/pf2e-foundry';
import { foundryPf2eRulesAdapter } from '@/ingest/packs/pf2e-rules';
import { clearDatabase } from '../db/helpers';

/**
 * The mob's spells as CHIPS (docs/17 row 184): the ONE `StatBlockCard` every
 * stat-block surface renders gains the section, a name that does not resolve
 * renders the UNRESOLVED state with the name visible, and the chip's detail is
 * `spellAtRank`'s output at the cast rank. Row 189 adds the LIBRARY half: a
 * real imported creature's OWN `spell` items reach the same field, so the
 * chips render through this SAME harness with no second path.
 */

const SPELL_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'spells');
const PF2E_CREATURE_FIXTURES = join(
  import.meta.dirname,
  '..',
  'fixtures',
  'packs',
  'pf2e',
);

async function realSpell(file: string, packRelative: string): Promise<SpellData> {
  const bytes = new TextEncoder().encode(readFileSync(join(SPELL_FIXTURES, file), 'utf8'));
  const parsed = await foundryPf2eRulesAdapter.parseFile(packRelative, bytes);
  expect(parsed.failures).toEqual([]);
  const spell = parsed.sections?.[0]?.spell;
  if (spell === undefined) throw new Error(`fixture ${file} produced no spell payload`);
  return spell;
}

let seq = 0;
async function seedSpells(spells: readonly { name: string; data: SpellData }[]): Promise<Id> {
  const book = await createPackBook({
    title: 'PF2e Spells',
    system: 'pathfinder2e',
    filename: 'spells.json',
  });
  const finished = await finalizePackBook(book.id, {
    sourceId: 'test-spells',
    license: 'ORC',
    entriesImported: spells.length,
    entriesSkipped: 0,
    entriesFailed: 0,
  });
  const chunks: RuleChunk[] = spells.map((spell) => {
    seq += 1;
    return ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: finished.id,
      pageStart: 1,
      pageEnd: 1,
      chunkType: 'spell',
      headingPath: ['Spells', spell.name],
      text: `${spell.name}\nSource: Pathfinder Player Core (ORC)`,
      statBlock: null,
      contentHash: 'c'.repeat(63) + String(seq % 10),
      spellData: spell.data,
    });
  });
  await putChunks(chunks);
  return finished.id;
}

function block(over: Record<string, unknown> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'pathfinder2e',
    level: '5',
    size: 'Small',
    creatureType: 'goblinoid',
    ac: 20,
    acNote: '',
    hp: 60,
    hpFormula: '',
    speed: '25 feet',
    abilities: { str: 14, dex: 16, con: 14, int: 16, wis: 12, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: 'Goblin',
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

beforeEach(async () => {
  await clearDatabase();
  seq = 0;
});
afterEach(cleanup);

describe('a mob stat block renders its spells as chips (docs/17 row 184)', () => {
  it('renders a resolved chip whose detail is the heightened values, and an unresolved chip by name', async () => {
    const fireball = await realSpell('fireball.json', 'spells/spells/rank-3/fireball.json');
    await seedSpells([{ name: 'Fireball', data: fireball }]);

    render(
      <StatBlockCard
        name="Grix"
        statBlock={block({
          spells: [
            { name: 'Fireball', castRank: 5 },
            { name: 'Flameball', castRank: 3 },
          ],
        })}
      />,
    );

    const section = await screen.findByTestId('mob-spells');
    const resolved = await within(section).findByTestId('spell-chip');
    expect(resolved).toHaveTextContent('Fireball');
    // Heightened to the CAST rank through the ONE rule (rank 5 → 10d6).
    expect(resolved.getAttribute('title')).toContain('cast at rank 5: 10d6 fire');
    expect(resolved.getAttribute('title')).toContain('heightening: interval');

    // The invented name is NOT hidden and NOT blank: the unresolved state.
    const unresolved = within(section).getByTestId('spell-chip-unresolved');
    expect(unresolved).toHaveTextContent('Flameball');
    expect(unresolved.getAttribute('data-spell-unresolved')).toBe('Flameball');

    // …and the loud issue names both halves.
    const issues = within(section).getByTestId('mob-spell-issues');
    expect(issues).toHaveTextContent('Flameball');
    expect(issues).toHaveTextContent('Grix');
  });

  it('auto-heightens a cantrip from the mob level, with no rank chosen by the caller', async () => {
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    await seedSpells([{ name: 'Ignition', data: ignition }]);

    render(<StatBlockCard name="Grix" statBlock={block({ spells: [{ name: 'Ignition' }] })} />);

    const section = await screen.findByTestId('mob-spells');
    const chip = await within(section).findByTestId('spell-chip');
    const title = chip.getAttribute('title') ?? '';
    expect(title).toContain('cast at rank 3');
    expect(title).toContain('cantrip, auto-heightened from the caster');
    expect(title).toContain('4d4 fire');
  });

  it('a LEGACY stat block without the field renders exactly as today — no chip section', async () => {
    await seedSpells([]);
    render(<StatBlockCard name="Grix" statBlock={block()} />);
    expect(await screen.findByText('Level 5')).toBeInTheDocument();
    expect(screen.queryByTestId('mob-spells')).not.toBeInTheDocument();
  });

  it('an authored EMPTY list is the same as no spells — nothing to show, nothing to error', async () => {
    await seedSpells([]);
    render(<StatBlockCard name="Grix" statBlock={block({ spells: [] })} />);
    expect(await screen.findByText('Level 5')).toBeInTheDocument();
    expect(screen.queryByTestId('mob-spells')).not.toBeInTheDocument();
  });

  it('renders a spell whose heightening is prose-only without inventing a number', async () => {
    const prosey = spellDataSchema.parse({
      system: 'pathfinder2e',
      rank: 3,
      cantrip: false,
      traditions: ['arcane'],
      traits: [],
      rarity: 'common',
      cast: { time: '', range: '', target: '', duration: '' },
      damage: { '0': { formula: '1d6', type: 'fire', category: null, materials: [] } },
      heightening: null,
      heighteningEntries: [{ kind: 'fixed', rank: 5, text: 'The damage increases to 3d6.' }],
      heighteningUnparsed: [],
      publication: null,
    });
    await seedSpells([{ name: 'Prosey', data: prosey }]);

    render(
      <StatBlockCard name="Grix" statBlock={block({ spells: [{ name: 'Prosey', castRank: 5 }] })} />,
    );

    const section = await screen.findByTestId('mob-spells');
    const chip = await within(section).findByTestId('spell-chip');
    const title = chip.getAttribute('title') ?? '';
    expect(title).toContain('The damage increases to 3d6.');
    expect(title).toContain('prose-only');
    expect(title).toContain('cast at rank 5: 1d6 fire');
  });

  it('renders an IMPORTED library mob\'s own spells through the ONE chips path (docs/17 row 189)', async () => {
    // The real upstream Ghost Mage, through the REAL bestiary adapter: its
    // embedded `spell` items reach `statBlock.spells`, and the SAME harness
    // above renders them — no second resolution or render path.
    const bytes = new Uint8Array(
      readFileSync(join(PF2E_CREATURE_FIXTURES, 'ghost-mage.json')),
    );
    const parsed = await foundryPf2eAdapter.parseFile('ghost-mage.json', bytes);
    expect(parsed.failures).toEqual([]);
    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Ghost Mage');
    if (entry === undefined) throw new Error('ghost-mage.json produced no creature entry');

    // The corpus holds the caster's own ranked spell AND its cantrip; every
    // other name it carries (e.g. Hallucination) is deliberately ABSENT.
    await seedSpells([
      {
        name: 'Blindness',
        data: spellDataSchema.parse({
          system: 'pathfinder2e',
          rank: 3,
          cantrip: false,
          cast: {},
        }),
      },
      {
        name: 'Detect Magic',
        data: spellDataSchema.parse({
          system: 'pathfinder2e',
          rank: 0,
          cantrip: true,
          cast: {},
        }),
      },
    ]);

    render(<StatBlockCard name={entry.name} statBlock={entry.statBlock} />);

    const section = await screen.findByTestId('mob-spells');
    const resolvedChips = await within(section).findAllByTestId('spell-chip');
    // Ranked: the ITEM's own rank 3 is the cast rank the chip asks the rule for.
    const ranked = resolvedChips.find((chip) => chip.textContent.includes('Blindness'));
    expect(ranked?.getAttribute('title')).toContain('cast at rank 3');
    // Cantrip: the importer stamped NO cast rank, so the rule auto-heightens it
    // from the mob's own level 10 → rank 5.
    const cantrip = resolvedChips.find((chip) => chip.textContent.includes('Detect Magic'));
    expect(cantrip?.getAttribute('title')).toContain('cantrip, auto-heightened');
    expect(cantrip?.getAttribute('title')).toContain('cast at rank 5');

    // A name the corpus does not hold is UNRESOLVED by name, and LOUD.
    const unresolved = within(section)
      .getAllByTestId('spell-chip-unresolved')
      .find((chip) => chip.getAttribute('data-spell-unresolved') === 'Hallucination');
    expect(unresolved).toBeDefined();
    expect(unresolved).toHaveTextContent('Hallucination');
    const issues = within(section).getByTestId('mob-spell-issues');
    expect(issues).toHaveTextContent('Hallucination');
    expect(issues).toHaveTextContent('Ghost Mage');
  });

  it('renders an IMPORTED focus spell at its auto-heightened rank through the ONE chips path (docs/17 row 191)', async () => {
    // The REAL upstream Lawbringer Warpriest, through the REAL bestiary
    // adapter: its `focus`-trait "Athletic Rush" item (level 1, no rank stated,
    // both casting entries' `autoHeightenLevel` null) reaches `statBlock.spells`
    // with NO cast rank, and the SAME harness renders it — the rank comes from
    // the ONE rule over the library's own focus spell document.
    const bytes = new Uint8Array(
      readFileSync(join(PF2E_CREATURE_FIXTURES, 'lawbringer-warpriest.json')),
    );
    const parsed = await foundryPf2eAdapter.parseFile('lawbringer-warpriest.json', bytes);
    expect(parsed.failures).toEqual([]);
    const entry = parsed.entries[0];
    expect(entry?.name).toBe('Lawbringer Warpriest');
    expect(entry?.statBlock.level).toBe('5');
    if (entry === undefined) throw new Error('lawbringer-warpriest.json produced no creature entry');

    // The rules corpus holds the focus spell itself (the chip resolves the NAME
    // against the library), so the end-to-end pin needs BOTH real documents.
    await seedSpells([
      {
        name: 'Athletic Rush',
        data: await realSpell('athletic-rush.json', 'spells/focus/athletic-rush.json'),
      },
    ]);

    render(<StatBlockCard name={entry.name} statBlock={entry.statBlock} />);

    const section = await screen.findByTestId('mob-spells');
    // The focus spell is the ONE seeded/resolvable chip; the mob's ranked and
    // cantrip names are deliberately unseeded and render unresolved.
    const chip = await within(section).findByTestId('spell-chip');
    expect(chip).toHaveTextContent('Athletic Rush');
    const title = chip.getAttribute('title') ?? '';
    // Upstream's rank for a level-5 actor: clamp(ceil(5 / 2)) = 3 — and the
    // detail names the FOCUS provenance, never the cantrip one.
    expect(title).toContain('cast at rank 3 (focus spell, auto-heightened)');
    expect(title).toContain('heightening: focus-auto');
    expect(title).not.toContain('cantrip-auto');
  });
});
