/**
 * THE ONE ingest HTML→text seam — its "exactly one" pin (AGENTS §Centralization
 * item 2, docs/17 row 143, docs/18 §2.1, docs/08 §One HTML→text seam).
 *
 * ## Why this file exists
 *
 * Seven pack adapters each carried their own HTML→text stripper. Nothing failed
 * when a copy was BORN — every copy was correct where it was written — so the
 * duplication was invisible until an audit ran all seven in memory against
 * shared inputs and found they had drifted into two block conventions and THREE
 * inline-notation dialects. No test could notice, because no test had ever
 * declared there was one way to do it. This file is that declaration.
 *
 * ## What is pinned, and why each half is needed
 *
 * 1. **DIFFERENTIAL** — one shared sample table (below) through all THREE
 *    declared styles, each style's exact output bytes asserted. Behaviour can
 *    only see a style that CHANGED; a fourth style that nothing calls is
 *    invisible to it, which is what half 2 is for.
 * 2. **SOURCE SCAN** — no second stripping implementation may exist in
 *    `src/ingest/packs/`, and all seven call sites must route through the seam
 *    with their declared style. A future copy eight fails here IMMEDIATELY
 *    instead of drifting for months; reverting one call site to its old body
 *    fails the count even though every behavioural pin stays green.
 * 3. **REAL FIXTURES** — one per group, pinning the STORED text bytes, because
 *    those bytes ARE the content hash (see the seam's header: a changed byte
 *    strands stored citations with no heal path).
 *
 * ## The divergence is KNOWN and DECLARED, never an accident
 *
 * The two groups differ on brace notation and on tables, and the difference is
 * still there — deliberately. Group A's (line-breaks-only) output is the
 * KNOWN, still-unfixed behaviour that landing 2 owns: fixing it here would
 * change the stored bytes of every PF2e item description and strand the
 * citations that hash them, with no re-import story and no contentHash
 * re-stamp migration. The pins below therefore assert the residue
 * (`Enfeebled{Enfeebled 1}`, `HardnessHPBT52010`) rather than what the text
 * SHOULD say, and each carries the `landing 2` marker so the next reader
 * cannot mistake it for something nobody noticed.
 *
 * ## What this file CANNOT prove
 *
 * No test can show that a future adapter author will not write copy eight: the
 * source scan is the GUARD, not a proof. And the scan's shape list is finite —
 * a stripper built from shapes nobody has used yet would slip past it, which is
 * why the scan also asserts the inverse (the seam's own shapes may appear in
 * `text.ts` and NOWHERE else in this directory).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACK_ADAPTERS } from '@/ingest/packs/registry';
import {
  AT_BRACE_LABEL_BLOCK_AND_TABLE,
  AT_LABEL_LAST_LINE_BREAKS,
  BRACKET_LINKS_LINE_BREAKS,
  htmlToText,
  type HtmlToTextStyle,
} from '@/ingest/packs/text';

/** The three declared styles, keyed by the name its call sites import. */
const STYLES = {
  AT_LABEL_LAST_LINE_BREAKS,
  BRACKET_LINKS_LINE_BREAKS,
  AT_BRACE_LABEL_BLOCK_AND_TABLE,
} as const satisfies Record<string, HtmlToTextStyle>;

type StyleId = keyof typeof STYLES;

/**
 * The seven call sites and the style each DECLARES. This is the whole point of
 * the refactor stated as data: seven sites, three styles, no site with a body
 * of its own. `callCount` is exact (2 for the creature adapter, which strips
 * both a melee item's and an action's description) so reverting ONE of its two
 * sites fails rather than hiding behind the other.
 */
const CALL_SITES: readonly {
  readonly file: string;
  readonly style: StyleId;
  readonly callCount: number;
}[] = [
  { file: 'pf2e-foundry.ts', style: 'AT_LABEL_LAST_LINE_BREAKS', callCount: 2 },
  { file: 'pf2e-equipment.ts', style: 'AT_LABEL_LAST_LINE_BREAKS', callCount: 1 },
  { file: 'dnd5e-foundry.ts', style: 'BRACKET_LINKS_LINE_BREAKS', callCount: 1 },
  { file: 'dnd5e-equipment.ts', style: 'BRACKET_LINKS_LINE_BREAKS', callCount: 1 },
  { file: 'pf2e-rules.ts', style: 'AT_BRACE_LABEL_BLOCK_AND_TABLE', callCount: 1 },
  { file: 'pf2e-journal.ts', style: 'AT_BRACE_LABEL_BLOCK_AND_TABLE', callCount: 1 },
  { file: 'pf2e-conditions.ts', style: 'AT_BRACE_LABEL_BLOCK_AND_TABLE', callCount: 1 },
];

interface SampleCase {
  readonly label: string;
  readonly html: string;
  /** The exact bytes each declared style must produce. */
  readonly expected: Readonly<Record<StyleId, string>>;
  /** `true` on the cases where the styles LEGITIMATELY differ — each one is the
   *  KNOWN, still-unfixed line-breaks-only behaviour (landing 2). */
  readonly declaredDivergence: boolean;
}

/**
 * ONE shared sample, the same one the audit used. Every case is either a case
 * the groups agree on (the agreement is pinned so a future style cannot quietly
 * detach one of them) or a case whose divergence is DECLARED as landing 2's.
 */
const SHARED_SAMPLE: readonly SampleCase[] = [
  {
    label: "plain paragraph",
    html: "<p>Hello world.</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "Hello world.",
      BRACKET_LINKS_LINE_BREAKS: "Hello world.",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Hello world.",
    },
    declaredDivergence: false,
  },
  {
    label: "nested <p> inside <div>",
    html: "<div><p>Outer <p>Inner</p></p></div>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "Outer Inner",
      BRACKET_LINKS_LINE_BREAKS: "Outer Inner",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Outer Inner",
    },
    declaredDivergence: false,
  },
  {
    label: "br only",
    html: "a<br>b<br/>c<br />d",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "a\nb\nc\nd",
      BRACKET_LINKS_LINE_BREAKS: "a\nb\nc\nd",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "a\nb\nc\nd",
    },
    declaredDivergence: false,
  },
  {
    label: "hr only",
    html: "a<hr>b<hr/>c<hr />d",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "a\nb\nc\nd",
      BRACKET_LINKS_LINE_BREAKS: "a\nb\nc\nd",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "a\nb\nc\nd",
    },
    declaredDivergence: false,
  },
  {
    label: "entities",
    html: "&nbsp;&amp;&lt;&gt;&quot;&#39;",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "&<>\"'",
      BRACKET_LINKS_LINE_BREAKS: "&<>\"'",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "&<>\"'",
    },
    declaredDivergence: false,
  },
  {
    label: "whitespace run",
    html: "a   \t  b",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "a b",
      BRACKET_LINKS_LINE_BREAKS: "a b",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "a b",
    },
    declaredDivergence: false,
  },
  {
    label: "brace form",
    html: "<p>@UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 1}</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "Enfeebled{Enfeebled 1}",
      BRACKET_LINKS_LINE_BREAKS: "Enfeebled{Enfeebled 1}",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Enfeebled 1",
    },
    declaredDivergence: true,
  },
  {
    label: "pipe form",
    html: "<p>@UUID[Compendium.pf2e.spells-srd.Item.Fireball|fireball]</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "Fireball",
      BRACKET_LINKS_LINE_BREAKS: "Fireball",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Fireball",
    },
    declaredDivergence: false,
  },
  {
    label: "label bracket form",
    html: "<p>[[/condition conditions:Incapacitated|incapacitated]]</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "[[/condition conditions:Incapacitated|incapacitated]]",
      BRACKET_LINKS_LINE_BREAKS: "incapacitated",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "[[/condition conditions:Incapacitated|incapacitated]]",
    },
    declaredDivergence: true,
  },
  {
    label: "bare bracket form",
    html: "<p>[[Compendium.dnd5e.spells.Item.Fireball]]</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "[[Compendium.dnd5e.spells.Item.Fireball]]",
      BRACKET_LINKS_LINE_BREAKS: "",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "[[Compendium.dnd5e.spells.Item.Fireball]]",
    },
    declaredDivergence: true,
  },
  {
    label: "label brace bracket form",
    html: "<p>[[Compendium.dnd5e.spells.Item.x]]{Fireball}</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "[[Compendium.dnd5e.spells.Item.x]]{Fireball}",
      BRACKET_LINKS_LINE_BREAKS: "Fireball",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "[[Compendium.dnd5e.spells.Item.x]]{Fireball}",
    },
    declaredDivergence: true,
  },
  {
    label: "reference form",
    html: "<p>&reference[Compendium.dnd5e.rules.x]{Ruling}</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "&reference[Compendium.dnd5e.rules.x]{Ruling}",
      BRACKET_LINKS_LINE_BREAKS: "Compendium.dnd5e.rules.x{Ruling}",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "&reference[Compendium.dnd5e.rules.x]{Ruling}",
    },
    declaredDivergence: true,
  },
  {
    label: "flat table",
    html: "<table><tr><td>Hardness</td><td>HP</td><td>BT</td></tr><tr><td>5</td><td>20</td><td>10</td></tr></table>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "HardnessHPBT52010",
      BRACKET_LINKS_LINE_BREAKS: "HardnessHPBT52010",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Hardness | HP | BT | 5 | 20 | 10",
    },
    declaredDivergence: true,
  },
  {
    label: "budget table",
    html: "<table><caption>Encounter Budget</caption><tr><th>Difficulty</th><th>XP Budget</th><th>Character Adjustment</th></tr><tr><td>Trivial</td><td>40 or less</td><td>10 or less</td></tr></table>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "Encounter BudgetDifficultyXP BudgetCharacter AdjustmentTrivial40 or less10 or less",
      BRACKET_LINKS_LINE_BREAKS: "Encounter BudgetDifficultyXP BudgetCharacter AdjustmentTrivial40 or less10 or less",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Encounter Budget\nDifficulty | XP Budget | Character Adjustment | Trivial | 40 or less | 10 or less",
    },
    declaredDivergence: true,
  },
  {
    label: "block closers",
    html: "<h2>Heading</h2><ul><li>One</li><li>Two</li></ul><blockquote>Quote</blockquote>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "HeadingOneTwoQuote",
      BRACKET_LINKS_LINE_BREAKS: "HeadingOneTwoQuote",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Heading\nOne\nTwo\nQuote",
    },
    declaredDivergence: true,
  },
  {
    label: "blank-line runs",
    html: "<p>a</p><p></p><p></p><p></p><p>b</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "a\n\n\n\nb",
      BRACKET_LINKS_LINE_BREAKS: "a\n\n\n\nb",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "a\n\nb",
    },
    declaredDivergence: true,
  },
  {
    label: "real-shaped pf2e ability",
    html: "<p><strong>Enfeebled 1</strong> — The target is enfeebled. <em>Source</em> @UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 1}</p>",
    expected: {
      AT_LABEL_LAST_LINE_BREAKS: "Enfeebled 1 — The target is enfeebled. Source Enfeebled{Enfeebled 1}",
      BRACKET_LINKS_LINE_BREAKS: "Enfeebled 1 — The target is enfeebled. Source Enfeebled{Enfeebled 1}",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Enfeebled 1 — The target is enfeebled. Source Enfeebled 1",
    },
    declaredDivergence: true,
  },
];

describe('the shared sample table: every declared style, exact bytes', () => {
  it('has 17 cases and every one is reachable by all three styles', () => {
    expect(SHARED_SAMPLE).toHaveLength(17);
    expect(Object.keys(STYLES)).toHaveLength(3);
    // Non-vacuity: the divergence half of this file must have something to say.
    expect(SHARED_SAMPLE.filter((sample) => sample.declaredDivergence).length).toBe(10);
  });

  it.each(SHARED_SAMPLE.map((sample) => [sample.label, sample] as const))(
    '%s',
    (_label, sample) => {
      for (const [id, style] of Object.entries(STYLES) as [StyleId, HtmlToTextStyle][]) {
        expect(htmlToText(sample.html, style), `${sample.label} / ${id}`).toBe(sample.expected[id]);
      }
    },
  );

  /**
   * The declared differences, EACH ONE NAMED AS landing 2's. The assertion is
   * the RESIDUE, not the fix. If a future landing repairs one of these without
   * the re-import story, this block goes red on purpose: the stored bytes are
   * the content hash, so a repair is a migration, never a quiet edit.
   */
  it('LANDING 2: a @-notation brace label survives VERBATIM in the line-breaks-only styles', () => {
    const html = '<p>@UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 1}</p>';
    // The residue the audit measured; the fixture that carries it is
    // tests/fixtures/packs/pf2e-equipment/anointing-oil.json.
    expect(htmlToText(html, AT_LABEL_LAST_LINE_BREAKS)).toBe('Enfeebled{Enfeebled 1}');
    expect(htmlToText(html, BRACKET_LINKS_LINE_BREAKS)).toBe('Enfeebled{Enfeebled 1}');
    // …and what it SHOULD say, which only the brace-aware style does today.
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe('Enfeebled 1');
  });

  it('LANDING 2: a table collapses to concatenated cells in the line-breaks-only styles', () => {
    const html =
      '<table><tr><td>Hardness</td><td>HP</td><td>BT</td></tr>'
      + '<tr><td>5</td><td>20</td><td>10</td></tr></table>';
    // The residue the audit measured; the fixture is
    // tests/fixtures/packs/pf2e-equipment/steel-shield.json.
    expect(htmlToText(html, AT_LABEL_LAST_LINE_BREAKS)).toBe('HardnessHPBT52010');
    expect(htmlToText(html, BRACKET_LINKS_LINE_BREAKS)).toBe('HardnessHPBT52010');
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe('Hardness | HP | BT | 5 | 20 | 10');
  });

  it('a whole table row survives as ONE line even in the table-aware style (the `</tr>` newline is swallowed)', () => {
    // MEASURED, and the old copies' comments had it wrong ("<tr> opens a
    // line"): the cell separator's `\s*` eats the newline `</tr>` just wrote,
    // so rows only break where a BLOCK CLOSER (here `</caption>`) intervenes.
    // The fixture is tests/fixtures/packs/pf2e-journal/gm-screen.json.
    const html =
      '<table><caption>Encounter Budget</caption>'
      + '<tr><th>Difficulty</th><th>XP Budget</th><th>Character Adjustment</th></tr>'
      + '<tr><td>Trivial</td><td>40 or less</td><td>10 or less</td></tr></table>';
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe(
      'Encounter Budget\n'
      + 'Difficulty | XP Budget | Character Adjustment | Trivial | 40 or less | 10 or less',
    );
    expect(htmlToText(html, AT_LABEL_LAST_LINE_BREAKS)).toBe(
      'Encounter BudgetDifficultyXP BudgetCharacter AdjustmentTrivial40 or less10 or less',
    );
  });

  it('the dnd5e bracket-link forms are literal text except in `bracket-links` (the third dialect)', () => {
    const html =
      '<p>[[Compendium.dnd5e.spells.Item.x]]{Fireball} and '
      + '[[/condition conditions:Incapacitated|incapacitated]]</p>';
    expect(htmlToText(html, BRACKET_LINKS_LINE_BREAKS)).toBe('Fireball and incapacitated');
    const literal =
      '[[Compendium.dnd5e.spells.Item.x]]{Fireball} and '
      + '[[/condition conditions:Incapacitated|incapacitated]]';
    expect(htmlToText(html, AT_LABEL_LAST_LINE_BREAKS)).toBe(literal);
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe(literal);
  });
});

// --- The "exactly one" half: the SOURCE --------------------------------

const PACKS_DIR = 'src/ingest/packs';

/**
 * The shapes an HTML→text stripper is built from. A copy eight is written with
 * one of these, whatever it is called and wherever in the flow it sits.
 */
const STRIPPER_SHAPES: readonly { readonly shape: string; readonly why: string }[] = [
  { shape: '<[^>]+>', why: 'the drop-every-tag regex' },
  { shape: '&nbsp;', why: 'the entity decode table' },
  { shape: '@(\\w+)\\[', why: 'the `@`-notation resolution' },
  { shape: '<br\\s*\\/?>', why: 'the tag-to-newline rule' },
];

function packSources(): string[] {
  return readdirSync(join(process.cwd(), PACKS_DIR))
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

const source = (file: string): string =>
  readFileSync(join(process.cwd(), PACKS_DIR, file), 'utf8');

describe('the ingest HTML→text seam is the ONLY one (SOURCE SCAN)', () => {
  it('leaves every stripper shape in text.ts and nowhere else in the directory', () => {
    const files = packSources();
    // Non-vacuity: the walk must see the whole directory (7 adapters + the
    // seam + `registry` + `types`), or this proves nothing about it.
    expect(files).toHaveLength(10);
    expect(files).toContain('text.ts');

    const offenders: string[] = [];
    for (const file of files) {
      if (file === 'text.ts') continue;
      const text = source(file);
      for (const { shape, why } of STRIPPER_SHAPES) {
        if (text.includes(shape)) offenders.push(`${file}: ${why} (\`${shape}\`)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has every one of the seven call sites routing through the seam with its declared style', () => {
    expect(CALL_SITES).toHaveLength(7);
    for (const { file, style, callCount } of CALL_SITES) {
      const text = source(file);
      expect(text, `${file} does not import the seam`).toContain(
        `import { htmlToText, ${style} } from './text';`,
      );
      const calls = text.match(/htmlToText\(/g) ?? [];
      expect(calls.length, `${file}: htmlToText call count`).toBe(callCount);
      const styled = text.match(new RegExp(`htmlToText\\([^;]*?${style}\\)`, 'gs')) ?? [];
      expect(styled.length, `${file}: calls passing ${style}`).toBe(callCount);
    }
  });

  it('declares exactly three styles, and every one of them is used by a site above', () => {
    const text = source('text.ts');
    const declared = text.match(/export const ([A-Z_]+): HtmlToTextStyle = \{/g) ?? [];
    expect(declared.map((line) => line.replace('export const ', '').replace(/: HtmlToTextStyle = \{/, '')))
      .toEqual(Object.keys(STYLES));
    for (const { style } of CALL_SITES) expect(STYLES[style]).toBeDefined();
    // No site may declare a style LITERAL of its own: a fourth combination in an
    // adapter file is exactly the copy-eight shape, one level up.
    for (const file of packSources()) {
      if (file === 'text.ts') continue;
      expect(source(file), `${file} declares an inline style`).not.toContain('blockAware');
    }
  });
});

// --- The bytes that ARE the content hash: the REAL fixtures -------------

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'packs');

async function laneTexts(dir: string, adapterId: string): Promise<{ name: string; text: string }[]> {
  const adapter = PACK_ADAPTERS.find((candidate) => candidate.id === adapterId);
  if (adapter === undefined) throw new Error(`no adapter ${adapterId}`);
  const out: { name: string; text: string }[] = [];
  for (const file of readdirSync(join(FIXTURES, dir)).sort()) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, dir, file)));
    const parsed = await adapter.parseFile(file, bytes);
    expect(parsed.failures, `${adapterId}/${file}`).toEqual([]);
    for (const entry of parsed.entries) out.push({ name: entry.name, text: entry.text });
    for (const item of parsed.items ?? []) out.push({ name: item.name, text: item.text });
    for (const section of parsed.sections ?? []) out.push({ name: section.name, text: section.text });
  }
  return out;
}

describe('the stored bytes of a real fixture — those bytes ARE the content hash', () => {
  /**
   * GROUP A (line-breaks-only) through the equipment lane, on the two fixtures
   * the audit named. Full TEXT equality, not `toContain`: a fragment pin lets
   * the surrounding bytes move, and the surrounding bytes are what
   * `sha256Hex(text)` signs.
   */
  it('anointing-oil.json stores the KNOWN brace residue (group A, landing 2)', async () => {
    const items = await laneTexts('pf2e-equipment', 'foundry-pf2e-equipment');
    const oil = items.find((entry) => entry.name === 'Anointing Oil');
    expect(oil?.text).toBe(
      'consumable · Level 4 · 18 gp · uncommon\n'
      + 'Carried by many Knights of Lastwall, this amber-colored, fragrant-smelling oil is meant to '
      + 'prevent those who fall in battle from rising as undead. Applying anointing oil to a corpse '
      + 'casts Peaceful Rest on it. The effects last for 24 hours.\n'
      + '\n'
      + 'The oil is repugnant to the undead. An undead creature that touches a corpse treated with this '
      + 'oil is Enfeebled{Enfeebled 1} until the contact is broken or the oil\'s effect wears off.\n'
      + 'Traits: consumable, magical, oil\n'
      + 'Source: Pathfinder Lost Omens Knights of Lastwall (OGL)',
    );
  });

  it('steel-shield.json stores the KNOWN table collapse (group A, landing 2)', async () => {
    const items = await laneTexts('pf2e-equipment', 'foundry-pf2e-equipment');
    const shield = items.find((entry) => entry.name === 'Steel Shield');
    expect(shield?.text).toBe(
      'shield · Level 0 · 2 gp · common\n'
      + 'Like wooden shields, steel shields come in a variety of shapes and sizes. Though more '
      + 'expensive than wooden shields, they are much more durable.\n'
      + 'HardnessHPBT52010\n'
      + 'Source: Pathfinder Player Core (ORC)',
    );
  });

  /**
   * GROUP B (block-and-table) through the journal lane — the fixture the
   * existing structural pin (`tests/ingest/packs/pf2e-journal.test.ts`, the
   * `Encounter Budget` case) reads fragments of, pinned here as WHOLE bytes.
   */
  it('gm-screen.json stores the table rows whole (group B)', async () => {
    const sections = await laneTexts('pf2e-journal', 'foundry-pf2e-journal');
    const budget = sections.find((entry) => entry.name === 'Encounter Budget');
    expect(budget?.text).toBe(
      'Encounter Budget\n'
      + 'Difficulty | XP Budget | Character Adjustment\n'
      + 'Trivial | 40 or less | 10 or less | Low | 60 | 20 | Moderate | 80 | 20 | '
      + 'Severe | 120 | 30 | Extreme | 160 | 40\n'
      + 'Source: Pathfinder GM Core pg. 75',
    );
    // The existing structural pin's two sentences, kept green through the seam.
    expect(budget?.text).toContain('Difficulty | XP Budget | Character Adjustment');
    expect(budget?.text).toContain('Trivial | 40 or less | 10 or less');
  });
});
