/**
 * THE ONE ingest HTML→text seam — its "exactly one" pin (AGENTS §Centralization
 * item 2, docs/17 rows 143 and 149, docs/18 §2.1, docs/08 §One HTML→text seam).
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
 *    behaviours: the two DECLARED styles plus the RETIRED `at-label-last`
 *    notation, each one's exact output bytes asserted. Behaviour can only see a
 *    style that CHANGED; a live style that nothing calls is invisible to it,
 *    which is what half 2 is for.
 * 2. **SOURCE SCAN** — no second stripping implementation may exist in
 *    `src/ingest/packs/`, and all eight call sites must route through the seam
 *    with their declared style. A future copy nine fails here IMMEDIATELY
 *    instead of drifting for months; reverting one call site to its old body
 *    fails the count even though every behavioural pin stays green.
 * 3. **REAL FIXTURES** — the stored text bytes of every lane's fixtures, hashed
 *    whole, because those bytes ARE the content hash (see the seam's header: a
 *    changed byte strands stored citations), with the fixtures that carry the
 *    repaired corruption asserted BYTE-EXACTLY.
 *
 * ## Row 149 flipped this file, and the direction matters
 *
 * Row 143 declared the corruption as CURRENT behaviour — the brace residue
 * (`Enfeebled{Enfeebled 1}`) and the table collapse (`HardnessHPBT52010`) —
 * with `LANDING 2:` pins, so a repair without the re-import story would go red
 * on purpose. Row 149 IS landing 2: those pins now assert the REPAIRED bytes,
 * and the OLD bytes are still asserted here against the RETIRED notation, so
 * "the fix" can never mean "the sample quietly changed shape" — and so the
 * FAILED-REVERT injection has a behaviour to revert a lane to.
 *
 * No pin was weakened (no `toEqual` became `toContain`) and none was deleted:
 * row 143's assertions all survive, flipped in place or twinned with the
 * retired-behaviour assertion beside them. The pins whose VALUES moved are
 * named in docs/08 §One HTML→text seam.
 *
 * ## Row 170 flips the three notation residues row 149 RECORDED
 *
 * Row 149 found three more residues in the same class, pinned them as CURRENT
 * behaviour with their fixture lines, and deliberately did not bundle them
 * (each needed a rule the seam did not have). This is that slice (docs/17 row
 * 170): `@Embed`'s space-separated option list, the dnd5e prelude's
 * case-sensitive `&reference[…]`, and the first-`]` truncation of a
 * nested-bracket `@Damage`. The pins that asserted the residues (the
 * `bag-of-beans.yml` / `saber-toothed-tiger.yml` fragments) FLIP here, the
 * nested-bracket residue gets the fixture pin it never had, and the rules are
 * stated as four new `SHARED_SAMPLE` rows. The three fixture entries whose
 * stored bytes move are the three residue carriers — every other lane's digest
 * is unchanged and asserted as unchanged.
 *
 * ## What this file CANNOT prove
 *
 * No test can show that a future adapter author will not write copy nine: the
 * source scan is the GUARD, not a proof. And nothing here can measure the
 * OWNER-VISIBLE consequence of row 149 — **how many stored citations in a real
 * library will read `missing ref (<name>)` after a re-import is unmeasured: it
 * needs his database, and it is the accepted cost (his decision, recorded in
 * docs/17 row 143), not a number this suite may invent.**
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACK_ADAPTERS } from '@/ingest/packs/registry';
import {
  AT_BRACE_LABEL_BLOCK_AND_TABLE,
  BRACKET_LINKS_LINE_BREAKS,
  htmlToText,
  type HtmlToTextStyle,
} from '@/ingest/packs/text';

/** The two styles the seam DECLARES, keyed by the name its call sites import. */
const STYLES = {
  BRACKET_LINKS_LINE_BREAKS,
  AT_BRACE_LABEL_BLOCK_AND_TABLE,
} as const satisfies Record<string, HtmlToTextStyle>;

type StyleId = keyof typeof STYLES;

/**
 * The RETIRED behaviour (docs/17 row 149): the two PF2e description lanes
 * declared this through row 143, which is what stored `Enfeebled{Enfeebled 1}`
 * and `HardnessHPBT52010`. The notation survives in the seam's enum SOLELY so
 * this file can state the old bytes and the FAILED-REVERT injection can revert
 * a lane's declaration to them; no adapter may import it, and the source scan
 * below proves none does.
 */
const RETIRED_AT_LABEL_LAST_LINE_BREAKS: HtmlToTextStyle = {
  notation: 'at-label-last',
  blockAware: false,
};

/** Every behaviour this file compares: the two live styles + the retired one. */
const BEHAVIOURS = {
  ...STYLES,
  RETIRED_AT_LABEL_LAST_LINE_BREAKS,
} as const satisfies Record<string, HtmlToTextStyle>;

type BehaviourId = keyof typeof BEHAVIOURS;

/**
 * The seven adapter files and the style each DECLARES. This is the whole point
 * of the refactor stated as data: eight call sites, two styles, no site with a
 * body of its own. `callCount` is exact (2 for the creature adapter, which
 * strips both a melee item's and an action's description) so reverting ONE of
 * its two sites fails rather than hiding behind the other.
 *
 * AMENDED by docs/17 row 149: `pf2e-foundry` (×2) and `pf2e-equipment` (×1)
 * moved from the retired `AT_LABEL_LAST_LINE_BREAKS` to the `@`-notation
 * block-and-table style, which is why the retired name appears in NO entry.
 */
const CALL_SITES: readonly {
  readonly file: string;
  readonly style: StyleId;
  readonly callCount: number;
}[] = [
  { file: 'pf2e-foundry.ts', style: 'AT_BRACE_LABEL_BLOCK_AND_TABLE', callCount: 2 },
  { file: 'pf2e-equipment.ts', style: 'AT_BRACE_LABEL_BLOCK_AND_TABLE', callCount: 1 },
  { file: 'dnd5e-foundry.ts', style: 'BRACKET_LINKS_LINE_BREAKS', callCount: 1 },
  { file: 'dnd5e-equipment.ts', style: 'BRACKET_LINKS_LINE_BREAKS', callCount: 1 },
  { file: 'pf2e-rules.ts', style: 'AT_BRACE_LABEL_BLOCK_AND_TABLE', callCount: 1 },
  { file: 'pf2e-journal.ts', style: 'AT_BRACE_LABEL_BLOCK_AND_TABLE', callCount: 1 },
  { file: 'pf2e-conditions.ts', style: 'AT_BRACE_LABEL_BLOCK_AND_TABLE', callCount: 1 },
];

interface SampleCase {
  readonly label: string;
  readonly html: string;
  /** The exact bytes each behaviour must produce. */
  readonly expected: Readonly<Record<BehaviourId, string>>;
  /** `true` on the cases where the three behaviours do NOT all agree; each one
   *  is named in a comment. The two LIVE styles' own disagreements are the two
   *  notation dialects — separate grammars, never merged. */
  readonly declaredDivergence: boolean;
}

/**
 * ONE shared sample, the same one the audit used. Every case is either a case
 * every behaviour agrees on (pinned so a future style cannot quietly detach one
 * of them) or a case whose divergence is DECLARED.
 */
const SHARED_SAMPLE: readonly SampleCase[] = [
  {
    label: "plain paragraph",
    html: "<p>Hello world.</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "Hello world.",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Hello world.",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "Hello world.",
    },
    declaredDivergence: false,
  },
  {
    label: "nested <p> inside <div>",
    html: "<div><p>Outer <p>Inner</p></p></div>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "Outer Inner",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Outer Inner",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "Outer Inner",
    },
    declaredDivergence: false,
  },
  {
    label: "br only",
    html: "a<br>b<br/>c<br />d",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "a\nb\nc\nd",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "a\nb\nc\nd",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "a\nb\nc\nd",
    },
    declaredDivergence: false,
  },
  {
    label: "hr only",
    html: "a<hr>b<hr/>c<hr />d",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "a\nb\nc\nd",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "a\nb\nc\nd",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "a\nb\nc\nd",
    },
    declaredDivergence: false,
  },
  {
    label: "entities",
    html: "&nbsp;&amp;&lt;&gt;&quot;&#39;",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "&<>\"'",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "&<>\"'",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "&<>\"'",
    },
    declaredDivergence: false,
  },
  {
    label: "whitespace run",
    html: "a   \t  b",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "a b",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "a b",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "a b",
    },
    declaredDivergence: false,
  },
  {
    // THE FLIPPED CASE (row 143 asserted `Enfeebled{Enfeebled 1}` for two of
    // these three behaviours). The brace label is the source's own display
    // text, so it wins in BOTH live styles; only the retired rule keeps the
    // residue.
    label: "brace form",
    html: "<p>@UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 1}</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "Enfeebled 1",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Enfeebled 1",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "Enfeebled{Enfeebled 1}",
    },
    declaredDivergence: true,
  },
  {
    label: "pipe form",
    html: "<p>@UUID[Compendium.pf2e.spells-srd.Item.Fireball|fireball]</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "Fireball",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Fireball",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "Fireball",
    },
    declaredDivergence: false,
  },
  {
    // The dnd5e dialect resolves `[[…]]`; the `@`-notation dialect has no rule
    // for it and must store it literally — two grammars, never one.
    label: "label bracket form",
    html: "<p>[[/condition conditions:Incapacitated|incapacitated]]</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "incapacitated",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "[[/condition conditions:Incapacitated|incapacitated]]",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "[[/condition conditions:Incapacitated|incapacitated]]",
    },
    declaredDivergence: true,
  },
  {
    label: "bare bracket form",
    html: "<p>[[Compendium.dnd5e.spells.Item.Fireball]]</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "[[Compendium.dnd5e.spells.Item.Fireball]]",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "[[Compendium.dnd5e.spells.Item.Fireball]]",
    },
    declaredDivergence: true,
  },
  {
    label: "label brace bracket form",
    html: "<p>[[Compendium.dnd5e.spells.Item.x]]{Fireball}</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "Fireball",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "[[Compendium.dnd5e.spells.Item.x]]{Fireball}",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "[[Compendium.dnd5e.spells.Item.x]]{Fireball}",
    },
    declaredDivergence: true,
  },
  {
    // STILL DECLARED RESIDUE (row 149), and NOT what row 170 fixed: the dnd5e
    // dialect's `&reference[…]` rule runs in its prelude, so the target is kept
    // and a `{Label}` written after it stays in the text. No dnd5e fixture
    // carries THIS shape — the fixture residue was the case-SENSITIVE spelling
    // `&Reference[prone]` (`tests/fixtures/packs/dnd5e/saber-toothed-tiger.yml`),
    // which row 170 repaired by adding the prelude rule's `i` flag (the
    // `uppercase reference form` case below). The `{Ruling}` tail is a
    // different, synthetic shape with no fixture, so it stays as recorded.
    label: "reference form",
    html: "<p>&reference[Compendium.dnd5e.rules.x]{Ruling}</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "Compendium.dnd5e.rules.x{Ruling}",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "&reference[Compendium.dnd5e.rules.x]{Ruling}",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "&reference[Compendium.dnd5e.rules.x]{Ruling}",
    },
    declaredDivergence: true,
  },
  {
    // THE FLIPPED CASE. Note the shape: with no `</thead>`/`</tbody>` and no
    // block closer between the rows, the cell separator's `\s*` swallows the
    // `</tr>` newline and the rows sit on ONE line — the real fixture
    // (`steel-shield.json`) carries `<thead>`/`<tbody>` and therefore breaks in
    // TWO, which its own byte-exact pin below asserts.
    label: "flat table",
    html: "<table><tr><td>Hardness</td><td>HP</td><td>BT</td></tr><tr><td>5</td><td>20</td><td>10</td></tr></table>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "HardnessHPBT52010",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Hardness | HP | BT | 5 | 20 | 10",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "HardnessHPBT52010",
    },
    declaredDivergence: true,
  },
  {
    label: "budget table",
    html: "<table><caption>Encounter Budget</caption><tr><th>Difficulty</th><th>XP Budget</th><th>Character Adjustment</th></tr><tr><td>Trivial</td><td>40 or less</td><td>10 or less</td></tr></table>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "Encounter BudgetDifficultyXP BudgetCharacter AdjustmentTrivial40 or less10 or less",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Encounter Budget\nDifficulty | XP Budget | Character Adjustment | Trivial | 40 or less | 10 or less",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "Encounter BudgetDifficultyXP BudgetCharacter AdjustmentTrivial40 or less10 or less",
    },
    declaredDivergence: true,
  },
  {
    label: "block closers",
    html: "<h2>Heading</h2><ul><li>One</li><li>Two</li></ul><blockquote>Quote</blockquote>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "HeadingOneTwoQuote",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Heading\nOne\nTwo\nQuote",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "HeadingOneTwoQuote",
    },
    declaredDivergence: true,
  },
  {
    // UNCHANGED in every behaviour, and it is the convention this landing must
    // NOT touch: ingest emits ONE `\n` per `</p>`, no blank-line collapse and no
    // per-line trim in the line-breaks-only style, because paragraphs are a
    // RENDER-time concern (`lib/textBlocks`, docs/17 row 146). A paragraph
    // convention introduced HERE would change every hash in the library.
    label: "blank-line runs",
    html: "<p>a</p><p></p><p></p><p></p><p>b</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "a\n\n\n\nb",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "a\n\nb",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "a\n\n\n\nb",
    },
    declaredDivergence: true,
  },
  {
    // THE FLIPPED CASE, in its real shape: a PF2e ability whose link carries a
    // brace label (the `anointing-oil.json` sentence). Only the retired rule
    // still produces `Enfeebled{Enfeebled 1}`.
    label: "real-shaped pf2e ability",
    html: "<p><strong>Enfeebled 1</strong> — The target is enfeebled. <em>Source</em> @UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 1}</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "Enfeebled 1 — The target is enfeebled. Source Enfeebled 1",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "Enfeebled 1 — The target is enfeebled. Source Enfeebled 1",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "Enfeebled 1 — The target is enfeebled. Source Enfeebled{Enfeebled 1}",
    },
    declaredDivergence: true,
  },
  {
    // ROW 170. `@Embed` is a third `@`-notation kind, not a dnd5e bracket link:
    // its bracket content is the target followed by a SPACE-separated option
    // list, so the shared `@`-rule resolves the first token and drops the
    // options BY RULE. It is a property of the `@`-grammar, which is why all
    // THREE behaviours agree here and why the rule lives in the seam rather
    // than in a prelude (the fixture is `dnd5e-equipment/bag-of-beans.yml`, and
    // its fragment pin below asserts the same bytes end to end).
    label: "embed argument list",
    html: "<p>@Embed[Compendium.dnd5e.tables24.RollTable.dmgBagOfBeansEff rollable caption=false]</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "dmgBagOfBeansEff",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "dmgBagOfBeansEff",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "dmgBagOfBeansEff",
    },
    declaredDivergence: false,
  },
  {
    // ROW 170. The nested-bracket PF2e damage formula. The brackets are read
    // BALANCED (the old rule stopped at the first `]` and split on the dot
    // inside `@item.level`, storing `level/2))[persistent,acid]`), the formula
    // is kept verbatim, and the bracketed damage-TYPE set is dropped BY RULE.
    // The fixture is `pf2e-rules/acid-splash.json`, pinned below.
    label: "nested-bracket damage formula",
    html: "<p>@Damage[(ceil(@item.level/2))[persistent,acid]]</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "(ceil(@item.level/2))",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "(ceil(@item.level/2))",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "(ceil(@item.level/2))",
    },
    declaredDivergence: false,
  },
  {
    // ROW 170. The dnd5e corpus spells the reference link `&Reference[prone]`
    // (`dnd5e/saber-toothed-tiger.yml`); the prelude's rule now carries the `i`
    // flag, so the uppercase spelling resolves exactly like the lowercase one.
    // This is a PRELUDE rule, so the other two behaviours keep the text
    // literally — a declared divergence, not a merge.
    label: "uppercase reference form",
    html: "<p>&Reference[prone]</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "prone",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "&Reference[prone]",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "&Reference[prone]",
    },
    declaredDivergence: true,
  },
  {
    // ROW 170 NON-REGRESSION, and the case that would have caught the WRONG
    // fix for `@Embed`: a UUID target may itself contain a space
    // (`anointing-oil.json`'s `Peaceful Rest`, `aid.json`'s `Effect: Aid`), so
    // the option-list split is scoped to `@Embed` and must NOT be applied to
    // every `@`-notation. All three behaviours keep the whole target.
    label: "space inside a uuid target",
    html: "<p>casts @UUID[Compendium.pf2e.spells-srd.Item.Peaceful Rest] on it</p>",
    expected: {
      BRACKET_LINKS_LINE_BREAKS: "casts Peaceful Rest on it",
      AT_BRACE_LABEL_BLOCK_AND_TABLE: "casts Peaceful Rest on it",
      RETIRED_AT_LABEL_LAST_LINE_BREAKS: "casts Peaceful Rest on it",
    },
    declaredDivergence: false,
  },
];

describe('the shared sample table: every declared style, exact bytes', () => {
  it('has 21 cases and every one is reachable by all three behaviours', () => {
    expect(SHARED_SAMPLE).toHaveLength(21);
    expect(Object.keys(STYLES)).toHaveLength(2);
    expect(Object.keys(BEHAVIOURS)).toHaveLength(3);
    // Non-vacuity, both halves: the divergence half must have something to say,
    // and so must the AGREEMENT half (so a future style cannot detach a case
    // every behaviour agrees on today and call it declared). Row 170 added
    // three agreement cases (`@Embed`, the damage formula, the space-in-UUID
    // non-regression) and one declared divergence (the uppercase reference,
    // which is a prelude rule).
    expect(SHARED_SAMPLE.filter((sample) => sample.declaredDivergence).length).toBe(11);
    expect(SHARED_SAMPLE.filter((sample) => !sample.declaredDivergence).length).toBe(10);
  });

  it.each(SHARED_SAMPLE.map((sample) => [sample.label, sample] as const))(
    '%s',
    (_label, sample) => {
      for (const [id, style] of Object.entries(BEHAVIOURS) as [BehaviourId, HtmlToTextStyle][]) {
        expect(htmlToText(sample.html, style), `${sample.label} / ${id}`).toBe(sample.expected[id]);
      }
    },
  );

  /**
   * ROW 149's repair, stated as the behaviour it changed. Row 143's pin
   * `LANDING 2: a @-notation brace label survives VERBATIM in the
   * line-breaks-only styles` asserted `Enfeebled{Enfeebled 1}` for BOTH
   * line-breaks-only styles; this is that pin FLIPPED, with the retired rule
   * asserted beside it so the old bytes are not merely described in a comment.
   */
  it('ROW 149: a @-notation brace label resolves to its LABEL in both live styles — and the retired rule still shows the old bytes', () => {
    const html = '<p>@UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 1}</p>';
    // The residue row 143 stored, still REACHABLE as the retired behaviour; the
    // fixture that carried it is
    // tests/fixtures/packs/pf2e-equipment/anointing-oil.json.
    expect(htmlToText(html, RETIRED_AT_LABEL_LAST_LINE_BREAKS)).toBe('Enfeebled{Enfeebled 1}');
    // …and what is STORED now, in BOTH live styles: the PF2e lanes (which moved
    // to `at-brace-label`) and the dnd5e lanes (whose dialect applies the same
    // brace rule after its own `[[…]]`/`&reference[…]` prelude).
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe('Enfeebled 1');
    expect(htmlToText(html, BRACKET_LINKS_LINE_BREAKS)).toBe('Enfeebled 1');
  });

  /**
   * Row 143's pin `LANDING 2: a table collapses to concatenated cells in the
   * line-breaks-only styles`, FLIPPED for the `@`-notation style and KEPT for
   * the dnd5e dialect — a DECISION with its evidence, not an oversight: no
   * dnd5e fixture under `tests/fixtures/packs/` carries a single
   * `<table>`/`<td>`/`<tr>` tag (measured over all 20 dnd5e fixture files), so
   * that lane asked for nothing and is not silently changed.
   */
  it('ROW 149: an @-notation table keeps its cells, and the dnd5e dialect is NOT changed (no dnd5e fixture carries table markup)', () => {
    const html =
      '<table><tr><td>Hardness</td><td>HP</td><td>BT</td></tr>'
      + '<tr><td>5</td><td>20</td><td>10</td></tr></table>';
    // The collapse row 143 stored: still the retired behaviour, and still the
    // dnd5e dialect's declared behaviour. The fixture that carried it is
    // tests/fixtures/packs/pf2e-equipment/steel-shield.json.
    expect(htmlToText(html, RETIRED_AT_LABEL_LAST_LINE_BREAKS)).toBe('HardnessHPBT52010');
    expect(htmlToText(html, BRACKET_LINKS_LINE_BREAKS)).toBe('HardnessHPBT52010');
    // …and what is STORED now by the PF2e lanes.
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe('Hardness | HP | BT | 5 | 20 | 10');
  });

  it('a whole table row survives as ONE line even in the table-aware style (the `</tr>` newline is swallowed)', () => {
    // MEASURED, and the old copies' comments had it wrong ("<tr> opens a
    // line"): the cell separator's `\s*` eats the newline `</tr>` just wrote,
    // so rows only break where a block closer — or a `</thead><tbody>` pair
    // that the drop-every-tag rule leaves between them — intervenes. The first
    // form is `gm-screen.json`'s `Encounter Budget`; the second is
    // `steel-shield.json`'s, whose byte-exact pin below asserts both rows.
    const html =
      '<table><caption>Encounter Budget</caption>'
      + '<tr><th>Difficulty</th><th>XP Budget</th><th>Character Adjustment</th></tr>'
      + '<tr><td>Trivial</td><td>40 or less</td><td>10 or less</td></tr></table>';
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe(
      'Encounter Budget\n'
      + 'Difficulty | XP Budget | Character Adjustment | Trivial | 40 or less | 10 or less',
    );
    expect(htmlToText(html, RETIRED_AT_LABEL_LAST_LINE_BREAKS)).toBe(
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
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe(literal);
    expect(htmlToText(html, RETIRED_AT_LABEL_LAST_LINE_BREAKS)).toBe(literal);
  });

  /**
   * The dnd5e dialect is NOT the PF2e one merged in: `[[…]]` and
   * `&reference[…]` resolve only under `bracket-links`. Row 149 shares the
   * BRACE rule (`@Type[…]{Label}`) between the two notations and NOTHING else —
   * the prelude stays the dnd5e grammar's own, and this pin is what would catch
   * a merge.
   */
  it('the two dialects stay separate: the dnd5e prelude resolves nothing in the @-notation style, and the shared brace rule is the only overlap', () => {
    const bracketOnly = '<p>[[/save]] and [[Compendium.dnd5e.spells.Item.x]]{Fireball}</p>';
    expect(htmlToText(bracketOnly, BRACKET_LINKS_LINE_BREAKS)).toBe('and Fireball');
    expect(htmlToText(bracketOnly, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe(
      '[[/save]] and [[Compendium.dnd5e.spells.Item.x]]{Fireball}',
    );
    const atOnly = '<p>@UUID[Compendium.pf2e.spells-srd.Item.Fireball|fireball]</p>';
    // Both resolve `@`-notation; what they do NOT share is the prelude above.
    expect(htmlToText(atOnly, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toBe('Fireball');
    expect(htmlToText(atOnly, BRACKET_LINKS_LINE_BREAKS)).toBe('Fireball');
  });
});

// --- The "exactly one" half: the SOURCE --------------------------------

const PACKS_DIR = 'src/ingest/packs';

/**
 * The shapes an HTML→text stripper is built from. A copy nine is written with
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

  it('has every one of the eight call sites routing through the seam with its declared style', () => {
    expect(CALL_SITES).toHaveLength(7);
    let calls = 0;
    for (const { file, style, callCount } of CALL_SITES) {
      const text = source(file);
      // The seam's import is matched NAME BY NAME, not as one literal line.
      // docs/17 row 147 added the document-parser helper (`parseJsonDocs` /
      // `parseYamlDocs`) to these very import statements, and a whole-line
      // `toContain` would fail on an addition that is the point of that row;
      // docs/17 row 171 added the shared document-record predicate
      // (`isDocumentRecord`) AND pushed the JSON lanes' import past Prettier's
      // 100-column width, so the statement may also be wrapped across lines.
      // The claim is unchanged and now asserted against the parsed name list —
      // the file imports `htmlToText` AND its declared style from `./text` —
      // and `parse-docs.test.ts` owns the parser/predicate half.
      const seamImport = /import \{([^}]*)\} from '\.\/text';/.exec(text);
      expect(seamImport, `${file} does not import from ./text`).not.toBeNull();
      const imported = (seamImport?.[1] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
      expect(imported, `${file} does not import htmlToText`).toContain('htmlToText');
      expect(imported, `${file} does not import the style it declares`).toContain(style);
      const found = text.match(/htmlToText\(/g) ?? [];
      expect(found.length, `${file}: htmlToText call count`).toBe(callCount);
      const styled = text.match(new RegExp(`htmlToText\\([^;]*?${style}\\)`, 'gs')) ?? [];
      expect(styled.length, `${file}: calls passing ${style}`).toBe(callCount);
      calls += callCount;
    }
    // Eight call sites over seven files (pf2e-foundry has two), counted as one
    // number too, so a site that migrates to another style cannot hide in the
    // per-file counts above.
    expect(calls).toBe(8);
  });

  it('declares exactly two styles, and every one of them is used by a site above', () => {
    const text = source('text.ts');
    const declared = text.match(/export const ([A-Z_]+): HtmlToTextStyle = \{/g) ?? [];
    expect(declared.map((line) => line.replace('export const ', '').replace(/: HtmlToTextStyle = \{/, '')))
      .toEqual(Object.keys(STYLES));
    for (const { style } of CALL_SITES) expect(STYLES[style]).toBeDefined();
    for (const file of packSources()) {
      if (file === 'text.ts') continue;
      // No site may declare a style LITERAL of its own: a third combination in
      // an adapter file is exactly the copy-nine shape, one level up.
      expect(source(file), `${file} declares an inline style`).not.toContain('blockAware');
      // …and the RETIRED behaviour is unreachable from an adapter BY NAME too:
      // row 149 repaired the two corrupted behaviours, and a quiet revert is
      // what the FAILED-REVERT injection proves the fixture pins would catch.
      // A name that no longer exists is the cheaper guard.
      expect(source(file), `${file} names the retired style`).not.toContain('AT_LABEL_LAST_LINE_BREAKS');
      expect(source(file), `${file} names the retired notation`).not.toContain('at-label-last');
    }
  });

  it('keeps the retired notation in the seam ONLY (it is what makes the repair provable)', () => {
    const text = source('text.ts');
    // Reachable ON PURPOSE: the differential table and the FAILED-REVERT proof
    // both need the old behaviour to exist in-tree. A future landing that
    // deletes it must REPLACE the proof, not lose it — this pin says so.
    expect(text).toContain("case 'at-label-last':");
    expect(text).toContain(
      "export type HtmlNotation = 'at-label-last' | 'at-brace-label' | 'bracket-links';",
    );
    // …and it is not an exported style constant, so no adapter can import it.
    expect(text).not.toContain('export const AT_LABEL_LAST_LINE_BREAKS');
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
   * The `@`-notation style through the equipment lane, on the two fixtures the
   * audit named. Full TEXT equality, not `toContain`: a fragment pin lets the
   * surrounding bytes move, and the surrounding bytes are what
   * `sha256Hex(text)` signs. ROW 149 flipped both VALUES (row 143 asserted the
   * residue on both); the exactness is unchanged.
   */
  it('anointing-oil.json stores the RESOLVED brace label (row 149 flipped the value, kept it byte-exact)', async () => {
    const items = await laneTexts('pf2e-equipment', 'foundry-pf2e-equipment');
    const oil = items.find((entry) => entry.name === 'Anointing Oil');
    expect(oil?.text).toBe(
      'consumable · Level 4 · 18 gp · uncommon\n'
      + 'Carried by many Knights of Lastwall, this amber-colored, fragrant-smelling oil is meant to '
      + 'prevent those who fall in battle from rising as undead. Applying anointing oil to a corpse '
      + 'casts Peaceful Rest on it. The effects last for 24 hours.\n'
      + '\n'
      + 'The oil is repugnant to the undead. An undead creature that touches a corpse treated with this '
      + 'oil is Enfeebled 1 until the contact is broken or the oil\'s effect wears off.\n'
      + 'Traits: consumable, magical, oil\n'
      + 'Source: Pathfinder Lost Omens Knights of Lastwall (OGL)',
    );
    // The bytes this fixture stored through row 143 are not merely gone: the
    // retired rule still produces them, so the difference above is a DECISION.
    expect(oil?.text).not.toContain('Enfeebled{Enfeebled 1}');
  });

  it('steel-shield.json stores the table as rows of cells (row 149 flipped the value, kept it byte-exact)', async () => {
    const items = await laneTexts('pf2e-equipment', 'foundry-pf2e-equipment');
    const shield = items.find((entry) => entry.name === 'Steel Shield');
    expect(shield?.text).toBe(
      'shield · Level 0 · 2 gp · common\n'
      + 'Like wooden shields, steel shields come in a variety of shapes and sizes. Though more '
      + 'expensive than wooden shields, they are much more durable.\n'
      + 'Hardness | HP | BT\n'
      + '5 | 20 | 10\n'
      + 'Source: Pathfinder Player Core (ORC)',
    );
    expect(shield?.text).not.toContain('HardnessHPBT52010');
  });

  /**
   * The dnd5e lanes carry the SAME defect in their own dialect, and a real
   * fixture proves it. This is the lane whose declaration did NOT change — its
   * GRAMMAR did: `@UUID[…]{nonmagical item}` used to store the target's last
   * dotted segment followed by the residue.
   *
   * ROW 170 FLIPPED the last assertion: the `@Embed` option list used to be
   * stored (`dmgBagOfBeansEff rollable caption=false` — row 149's recorded
   * residue) and is now dropped BY RULE, leaving the target's last segment.
   */
  it('bag-of-beans.yml (dnd5e) stores the RESOLVED brace label and the @Embed TARGET, not its option list', async () => {
    const items = await laneTexts('dnd5e-equipment', 'foundry-dnd5e-equipment');
    const beans = items.find((entry) => entry.name === 'Bag of Beans');
    expect(beans?.text).toContain('becomes a nonmagical item when it no longer contains any beans.');
    expect(beans?.text).not.toContain('phbagPouch000000{nonmagical item}');
    // The ROW 170 flip, both directions: the embed target survives with its
    // surrounding prose, and the space-separated option list is GONE.
    expect(beans?.text).toContain('Bag of Beans Effect (click to expand)dmgBagOfBeansEff\n');
    expect(beans?.text).not.toContain('rollable caption=false');
    expect(beans?.text).not.toContain('dmgBagOfBeansEff rollable');
  });

  it('saber-toothed-tiger.yml (dnd5e creature) stores the RESOLVED brace label and the case-insensitive reference', async () => {
    const entries = await laneTexts('dnd5e', 'foundry-dnd5e-srd');
    const tiger = entries.find((entry) => entry.name === 'Saber-Toothed Tiger');
    expect(tiger?.text).toContain('it with a claw attack on the same turn');
    expect(tiger?.text).not.toContain('7GCnVtakQo6iZyn7{claw}');
    // ROW 170 FLIPPED this: the prelude's `&reference[…]` rule carries the `i`
    // flag, so the corpus' own `&amp;Reference[prone]` resolves to the bare
    // target instead of surviving verbatim as `&Reference[prone]`.
    expect(tiger?.text).toContain('or be knocked prone.');
    expect(tiger?.text).not.toContain('&Reference[prone]');
    expect(tiger?.text).not.toContain('&amp;Reference');
  });

  /**
   * ROW 170's third residue, and it had NO fixture pin at all (docs/18 §5 said
   * so): the nested-bracket PF2e damage formula. The old first-`]` rule stored
   * `level/2))[persistent,acid]` — debris from the middle of the expression;
   * the balanced scan keeps the formula and drops the damage-TYPE set by rule.
   * The pin runs through the real `pf2e-rules` adapter, so it is the STORED
   * bytes (and therefore the content hash) that are asserted.
   */
  it('acid-splash.json (pf2e rules) stores the nested damage FORMULA, not a fragment — the pin row 149 could not add', async () => {
    const rules = await laneTexts('pf2e-rules', 'foundry-pf2e-rules');
    const acid = rules.find((entry) => entry.name === 'Acid Splash');
    expect(acid?.text).toContain('the target also takes (ceil(@item.level/2)) damage.');
    expect(acid?.text).not.toContain('level/2))[persistent,acid]');
    expect(acid?.text).not.toContain('[persistent,acid]');
  });

  /**
   * The block-and-table lane through the journal fixture the existing
   * structural pin (`tests/ingest/packs/pf2e-journal.test.ts`, the
   * `Encounter Budget` case) reads fragments of, pinned here as WHOLE bytes.
   * UNCHANGED by row 149, byte for byte.
   */
  it('gm-screen.json stores the table rows whole (block-and-table lane, unchanged by row 149)', async () => {
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

/**
 * EVERY lane's emitted text, hashed — the pin that makes "this lane changed" a
 * fact rather than a claim. Row 149's brief requires that a lane which changes
 * without a decision record is a DEFECT, and the two named fixtures above only
 * cover the `@`-notation equipment lane: this block hashes the whole output of
 * all seven adapters over all 38 fixture files, so a change anywhere fails with
 * the LANE named, and a lane declared unchanged can only pass by really not
 * moving.
 *
 * Each digest is `sha256` over `name \0 text \0` per emitted entry, in the
 * adapter's own order (files sorted, then entries, items, sections) — i.e. over
 * exactly the strings that become `contentHash`.
 *
 * THE ROW-149 RECORD, before → after, captured with the same harness on the
 * base tree and on this one:
 *
 * - `foundry-pf2e`            UNCHANGED — the declaration moved to the
 *                             `@`-notation block-and-table style, and
 *                             `pf2e/wolf.json` carries NEITHER a brace form nor
 *                             a table, so no byte moved (reported, not assumed)
 * - `foundry-pf2e-journal`    UNCHANGED
 * - `foundry-pf2e-conditions` UNCHANGED
 * - `foundry-pf2e-rules`      UNCHANGED
 * - `foundry-dnd5e-srd`       CHANGED (1 of 13 entries: saber-toothed-tiger)
 * - `foundry-pf2e-equipment`  CHANGED (2 of 11: anointing-oil, steel-shield)
 * - `foundry-dnd5e-equipment` CHANGED (1 of 7: bag-of-beans)
 *
 * THE ROW-170 RECORD, the same harness, `after` moved only for the three
 * residue carriers — one entry each, and the only lanes allowed to move here:
 *
 * - `foundry-pf2e-rules`      CHANGED (1 of 4: acid-splash — the nested
 *                             `@Damage` formula; the ONE lane row 149 declared
 *                             unchanged that moves now)
 * - `foundry-dnd5e-srd`       CHANGED again (saber-toothed-tiger: the
 *                             case-insensitive `&Reference[prone]` resolves)
 * - `foundry-dnd5e-equipment` CHANGED again (bag-of-beans: the `@Embed` option
 *                             list is dropped)
 * - `foundry-pf2e`, `-journal`, `-conditions`, `-equipment` UNCHANGED — each
 *   asserted as unchanged because its `before === after`
 *
 * `before` stays the PRE-ROW-149 digest: for an unchanged lane it is asserted
 * equal to the running digest (so "this lane never moved, in either landing"
 * is checkable), and for a changed lane the pin is the `after` value alone.
 */
const LANES: readonly {
  readonly adapterId: string;
  readonly dir: string;
  readonly entries: number;
  /** The digest BEFORE row 149 — kept so the unchanged claim is checkable. */
  readonly before: string;
  /** The digest this landing (row 170) requires. */
  readonly after: string;
}[] = [
  {
    adapterId: 'foundry-pf2e',
    dir: 'pf2e',
    entries: 1,
    before: 'f722b48d56787f6e3a518a25904651f0a3de624d3f2bcc8ac861f6009aac06e6',
    after: 'f722b48d56787f6e3a518a25904651f0a3de624d3f2bcc8ac861f6009aac06e6',
  },
  {
    adapterId: 'foundry-dnd5e-srd',
    dir: 'dnd5e',
    entries: 13,
    before: '37b62168a64b9cced1e766b4935e560105081a094599f892b957cabb9a2e0a62',
    after: '7d2a3edc661efb85cc5375a7649345b60a026f804daee1f1c982baa38d8eabb1',
  },
  {
    adapterId: 'foundry-pf2e-equipment',
    dir: 'pf2e-equipment',
    entries: 11,
    before: '2d402531844be3689e3b676b53368fe6a4d224fdaef129f9d0bee1005bfaffa3',
    after: '0abb529510c35056c57d96239cad7e94c8d5aa5cd68dc5636b6a63c1ee20fefd',
  },
  {
    adapterId: 'foundry-dnd5e-equipment',
    dir: 'dnd5e-equipment',
    entries: 7,
    before: 'e9eee757148f8e2f523e9538ec25b8415ab366746773656978f6742bef5dc1da',
    after: '645871ac4d04ebbc1388104f25e93bd90abe7c6df807c37c31e1a615dd8e755e',
  },
  {
    adapterId: 'foundry-pf2e-journal',
    dir: 'pf2e-journal',
    entries: 3,
    before: 'a10970223e696a7f57974408946ff1dbb8d3a77fa2e9df52a27542fd7c1efa41',
    after: 'a10970223e696a7f57974408946ff1dbb8d3a77fa2e9df52a27542fd7c1efa41',
  },
  {
    adapterId: 'foundry-pf2e-conditions',
    dir: 'pf2e-conditions',
    entries: 2,
    before: 'b604ea85ff756d9814eade7548258fd26a08b643a743d75487202ad3686b6450',
    after: 'b604ea85ff756d9814eade7548258fd26a08b643a743d75487202ad3686b6450',
  },
  {
    adapterId: 'foundry-pf2e-rules',
    dir: 'pf2e-rules',
    entries: 4,
    before: 'c41b367a9422b0a989962f18ed51ef6bb2ea3850afd27eaa1ef3fb697a8ce954',
    after: '10f9460ffcd66d7b440ced8faa4d7dd93af7448b5cb22c322dd2de9087edd9f5',
  },
];

describe("every lane's emitted text, hashed (a lane that changed is NAMED, never inferred)", () => {
  it.each(LANES.map((lane) => [lane.adapterId, lane] as const))(
    '%s',
    async (adapterId, lane) => {
      const texts = await laneTexts(lane.dir, adapterId);
      expect(texts).toHaveLength(lane.entries);
      const digest = createHash('sha256')
        .update(texts.map((entry) => `${entry.name}\u0000${entry.text}\u0000`).join(''))
        .digest('hex');
      expect(digest, `${adapterId}: emitted text changed`).toBe(lane.after);
      // The UNCHANGED lanes are asserted as unchanged, not merely as equal to
      // some constant: equal to their own pre-row-149 digest is the claim "this
      // lane's stored bytes did not move", and only a lane that must not move
      // can make it. A changed lane fails here by construction.
      if (lane.before === lane.after) {
        expect(digest, `${adapterId}: was declared UNCHANGED by row 149`).toBe(lane.before);
      }
    },
  );
});

// --- FAILED REVERT: the old bytes are still reachable -------------------

describe('FAILED REVERT — the retired behaviour still produces the pre-row-149 bytes', () => {
  /**
   * Row 149's injection (a) reverts ONE lane's declaration to the retired style
   * and requires the fixture pin to go RED. That proof is only meaningful if
   * the retired style really does still emit the old bytes, so this pins it on
   * the REAL fixture HTML (`system.description.value`), read from the file —
   * the same string the adapter strips.
   *
   * These two snippets ARE the corruption the owner reported
   * (`Enfeebled{Enfeebled 1}`, `HardnessHPBT52010`), asserted here as the OLD
   * behaviour, so no comment has to be trusted for it.
   */
  const rawDescription = (dir: string, file: string): string => {
    const doc = JSON.parse(readFileSync(join(FIXTURES, dir, file), 'utf8')) as {
      system: { description: { value: string } };
    };
    return doc.system.description.value;
  };

  it('anointing-oil.json’s own HTML: retired → the old residue, declared → the label', () => {
    const html = rawDescription('pf2e-equipment', 'anointing-oil.json');
    expect(html).toContain('@UUID[Compendium.pf2e.conditionitems.Item.Enfeebled]{Enfeebled 1}');
    expect(htmlToText(html, RETIRED_AT_LABEL_LAST_LINE_BREAKS)).toContain('Enfeebled{Enfeebled 1}');
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).not.toContain('Enfeebled{Enfeebled 1}');
  });

  it('steel-shield.json’s own HTML: retired → the old collapse, declared → the cells', () => {
    const html = rawDescription('pf2e-equipment', 'steel-shield.json');
    expect(html).toContain('<th>Hardness</th>');
    expect(htmlToText(html, RETIRED_AT_LABEL_LAST_LINE_BREAKS)).toContain('HardnessHPBT52010');
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).toContain('Hardness | HP | BT\n5 | 20 | 10');
    expect(htmlToText(html, AT_BRACE_LABEL_BLOCK_AND_TABLE)).not.toContain('HardnessHPBT52010');
  });
});
