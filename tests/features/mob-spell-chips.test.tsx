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
import { foundryDnd5eSrdAdapter } from '@/ingest/packs/dnd5e-foundry';
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
async function seedSpells(
  spells: readonly { name: string; data: SpellData }[],
  system: 'pathfinder2e' | 'dnd5e' = 'pathfinder2e',
): Promise<Id> {
  const book = await createPackBook({
    title: system === 'dnd5e' ? 'SRD Spells' : 'PF2e Spells',
    system,
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

  it('IGNORES a stray cross-system field with a QUIET warning — never "a spell it cannot use" (docs/17 row 205)', async () => {
    // THE OWNER'S REAL RUN: a saved PF2e NPC whose assignments carry the dnd5e
    // `casterLevel`/`characterLevel` (our own contract asked for them). The
    // stored row needs NO migration — the chip renders the correct values and
    // the note is separate from the loud issue box.
    const ignition = await realSpell('ignition.json', 'spells/spells/cantrip/ignition.json');
    await seedSpells([{ name: 'Ignition', data: ignition }]);

    render(
      <StatBlockCard
        name="Nirklex"
        statBlock={block({
          spells: [{ name: 'Ignition', casterLevel: 8, characterLevel: 8 }],
        })}
      />,
    );

    const section = await screen.findByTestId('mob-spells');
    const chip = await within(section).findByTestId('spell-chip');
    // The cantrip still auto-heightens from the mob's OWN level 5 → rank 3.
    const title = chip.getAttribute('title') ?? '';
    expect(title).toContain('cast at rank 3');
    expect(title).toContain('4d4 fire');
    // NO loud issue box (so no repair turn at the boundary)…
    expect(within(section).queryByTestId('mob-spell-issues')).not.toBeInTheDocument();
    // …and the honest note is present, naming the mob.
    const warnings = within(section).getByTestId('mob-spell-warnings');
    expect(warnings).toHaveTextContent('Nirklex');
    expect(warnings).toHaveTextContent('other game system');
    expect(warnings).toHaveTextContent('ignored');
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

/**
 * The dnd5e library-mob half (docs/17 row 194). The CREATURE fixture is a real
 * carve of the upstream `6.0.x` Mage (two embedded spell items at levels 0 and
 * 3 — see its header comment), and the library spells are the REAL Fire Bolt
 * and Fireball documents, so the per-level mapping, the rank and the chips all
 * come from upstream bytes rather than from a synthesised shape.
 */
describe('a dnd5e library creature renders its OWN spells as chips (row 194)', () => {
  const DND5E_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'packs', 'dnd5e');

  async function realDnd5eSpell(file: string, packRelative: string): Promise<SpellData> {
    const bytes = new TextEncoder().encode(readFileSync(join(DND5E_FIXTURES, file), 'utf8'));
    const parsed = await foundryDnd5eSrdAdapter.parseFile(packRelative, bytes);
    expect(parsed.failures).toEqual([]);
    const spell = parsed.sections?.[0]?.spell;
    if (spell === undefined) throw new Error(`fixture ${file} produced no spell payload`);
    return spell;
  }

  /**
   * A dnd5e creature at a stated character level (row 194's cantrip tier
   * input). The underlying stat block fields are the PF2e-shaped shared
   * `statBlockSchema` — this test drives the dnd5e CHIP path, and the creature
   * document's own mapping is pinned in
   * `tests/ingest/packs/dnd5e-foundry.test.ts`.
   */
  function dnd5eBlock(over: Record<string, unknown> = {}): StatBlock {
    return statBlockSchema.parse({
      system: 'dnd5e',
      level: '9',
      size: 'Medium',
      creatureType: 'humanoid',
      ac: 12,
      acNote: '',
      hp: 40,
      hpFormula: '9d8',
      speed: '30 feet',
      abilities: { str: 9, dex: 14, con: 11, int: 17, wis: 12, cha: 11 },
      saves: 'Int +6, Wis +4',
      skills: 'Arcana +6, History +6',
      senses: 'passive Perception 11',
      languages: 'Common plus three more',
      traits: [],
      actions: [],
      reactions: [],
      legendary: [],
      extras: {},
      ...over,
    });
  }

  it('maps a real caster creature own spell items to per-level chips, resolving through the 5e corpus', async () => {
    const fireBolt = await realDnd5eSpell('spells/cantrip-fire-bolt.yml', 'spells/cantrip/fire-bolt.yml');
    const fireball = await realDnd5eSpell('spells/3rd-level-fireball.yml', 'spells/3rd-level/fireball.yml');
    await seedSpells(
      [
        { name: 'Fire Bolt', data: fireBolt },
        { name: 'Fireball', data: fireball },
      ],
      'dnd5e',
    );

    // The importer's real assignments for the Mage carves two spell items,
    // with the creature's caster level riding them.
    const assignments = [
      { name: 'Fire Bolt', casterLevel: 9, characterLevel: 9 },
      { name: 'Fireball', castRank: 3, casterLevel: 9, characterLevel: 9 },
    ];
    render(<StatBlockCard name="Cult Mage" statBlock={dnd5eBlock({ spells: assignments })} />);

    const section = await screen.findByTestId('mob-spells');
    const chips = await within(section).findAllByTestId('spell-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Fire Bolt', 'Fireball']);

    // The 5e cantrip: LEVEL 0 and the system's OWN tier dice (character level
    // 9 → one tier applied → 2d10), never a PF2e rank.
    const cantripTitle = chips[0]?.getAttribute('title') ?? '';
    expect(cantripTitle).toContain('cast at level 0');
    expect(cantripTitle).toContain('2d10 fire');
    expect(cantripTitle).toContain('cantrip, scaled by the caster');
    expect(cantripTitle).toContain('upcasting: upcast');
    expect(cantripTitle).not.toContain('cast at rank');

    // The levelled spell: level 3 is the cast rank, the source's own 8d6.
    const fireballTitle = chips[1]?.getAttribute('title') ?? '';
    expect(fireballTitle).toContain('cast at level 3: 8d6 fire');
    expect(fireballTitle).toContain('the damage increases by 1d6');
  });

  it('a name the 5e corpus lacks is a LOUD unresolved chip, and a spell-less creature omits the key', async () => {
    const fireBolt = await realDnd5eSpell('spells/cantrip-fire-bolt.yml', 'spells/cantrip/fire-bolt.yml');
    await seedSpells([{ name: 'Fire Bolt', data: fireBolt }], 'dnd5e');

    render(
      <StatBlockCard
        name="Cult Mage"
        statBlock={dnd5eBlock({
          spells: [
            { name: 'Fire Bolt', casterLevel: 9, characterLevel: 9 },
            { name: 'Eldritch Blast' },
          ],
        })}
      />,
    );

    const section = await screen.findByTestId('mob-spells');
    const unresolved = await within(section).findByTestId('spell-chip-unresolved');
    expect(unresolved).toHaveTextContent('Eldritch Blast');
    expect(within(section).getByTestId('mob-spell-issues')).toHaveTextContent(
      'Eldritch Blast',
    );

    // A creature with NO spells carries no `spells` key at all → no section.
    cleanup();
    render(<StatBlockCard name="Cult Mage" statBlock={dnd5eBlock()} />);
    expect(await screen.findByText('Level 9')).toBeInTheDocument();
    expect(screen.queryByTestId('mob-spells')).not.toBeInTheDocument();
  });
});
