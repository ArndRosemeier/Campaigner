import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';


import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact as createArtifactRow, newId, statBlockSchema, type StatBlock } from '@/domain';
import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import { statBoxContent } from '@/lib/modulePdf';
import { buildGmNotesDefinition, buildPlayerHandoutDefinition } from '@/lib/pdfExport';
import { blockText, textBlocks } from '@/lib/textBlocks';
import { clearDatabase } from '../db/helpers';

/**
 * ONE plain-text→blocks rule, TWO consumers (docs/17 row 146, docs/18 §2.3).
 *
 * The owner reads his documents and reports *"big text blobs without any
 * paragraph… walls of text, no formatting at all, describing monsters."* Two
 * renderers were responsible, in two different ways: the app's `StatBlockCard`
 * printed a field inside a `<span>` (HTML collapses every newline to one space)
 * and the PDF put the whole body in ONE run (pdfmake prints a blank line as an
 * empty line, not as a paragraph). The rule that decides where the paragraphs
 * ARE is one function, `lib/textBlocks.textBlocks`; each renderer only decides
 * how to DRAW a block.
 *
 * These pins hold three things:
 *
 * - the RULE itself (a blank line separates blocks, a single newline is a LINE
 *   BREAK inside one block — the two are DISTINCT and pinned apart);
 * - the two consumers AGREE on one fixture, three ways: the rule's own answer,
 *   the app's rendered blocks and the PDF's runs are the same strings in the
 *   same order;
 * - EXACTLY ONE implementation (AGENTS rule 4, made mechanical): a source scan
 *   over `src/**` finds the rule defined once, both consumers reaching it, and
 *   no paragraph splitting in either consumer.
 */

/** The fixture: two paragraphs, and a LINE BREAK inside the second one. */
const PARAGRAPHED = 'It hunts by vibration.\n\nThe antennae drag the shallows.\nIt cannot see you.';

/** A stat block whose ONLY prose field is the trait body — so a rendered block
 * count is the fixture's own answer, not a sum over five fields. */
function paragraphBlock(): StatBlock {
  return statBlockSchema.parse({
    system: 'pathfinder2e',
    level: '4',
    size: 'Medium',
    creatureType: 'animal',
    ac: 18,
    acNote: '',
    hp: 44,
    hpFormula: '8d8',
    speed: '30 ft.',
    abilities: { str: 14, dex: 18, con: 12, int: 2, wis: 14, cha: 6 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [{ name: 'Grasping Antennae', text: PARAGRAPHED }],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
  });
}

/** Every string run of a pdfmake node, in document order. */
function runsOf(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const child of node) runsOf(child, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const record = node as Record<string, unknown>;
  const text: unknown = record.text;
  if (typeof text === 'string') out.push(text);
  else if (text !== undefined) runsOf(text, out);
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'text') runsOf(value, out);
  }
  return out;
}

/** `src/**` as text, for the source pins (comments stripped: a RULE is what
 * executes, not what a comment says about it). */
function sourceFiles(): { path: string; code: string }[] {
  // `process.cwd()` is the project root under vitest (the same place
  // `vite.config.ts`'s alias resolves from); `import.meta.url` is not a
  // `file:` URL in this jsdom environment.
  const root = join(process.cwd(), 'src');
  const out: { path: string; code: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push({
          path: full.slice(root.length + 1),
          code: readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, ''),
        });
      }
    }
  };
  walk(root);
  return out;
}

beforeEach(clearDatabase);

describe('textBlocks — the ONE rule (blank line = paragraph, single newline = line break)', () => {
  it('a blank line separates blocks and a single newline stays INSIDE one', () => {
    const blocks = textBlocks(PARAGRAPHED);
    expect(blocks.map(blockText)).toEqual([
      'It hunts by vibration.',
      'The antennae drag the shallows.\nIt cannot see you.',
    ]);
    // The two behaviours are DISTINCT: a single `\n` did not become a block.
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.lines).toEqual(['The antennae drag the shallows.', 'It cannot see you.']);
  });

  it('several blank lines are ONE paragraph break, and whitespace-only lines count as blank', () => {
    expect(textBlocks('One.\n\n\n\nTwo.')).toHaveLength(2);
    expect(textBlocks('One.\n   \n\t\nTwo.')).toHaveLength(2);
    expect(textBlocks('\n\nOne.\n\n')).toHaveLength(1);
  });

  it('carriage returns are normalised (a model on any platform writes the same blocks)', () => {
    expect(textBlocks('One.\r\n\r\nTwo.\r\nStill two.').map(blockText)).toEqual([
      'One.',
      'Two.\nStill two.',
    ]);
  });

  it('whitespace-only text carries NO block (an empty field renders nothing, not an empty line)', () => {
    expect(textBlocks('')).toEqual([]);
    expect(textBlocks('   \n\t\n ')).toEqual([]);
  });

  it('trailing whitespace is an artefact of the model’s wrap and is dropped; indentation is kept', () => {
    expect(textBlocks('One.   \n  Two.  ').map(blockText)).toEqual(['One.\n  Two.']);
  });
});

describe('the two consumers draw the SAME blocks as the rule', () => {
  it('the reader renders one element per block, the second one block-level', () => {
    render(<StatBlockCard statBlock={paragraphBlock()} name="Cave Fisher" />);
    const rendered = screen.getAllByTestId('text-block').map((node) => node.textContent);
    // Three-way agreement: the rule's own answer, the app's blocks…
    expect(rendered).toEqual(textBlocks(PARAGRAPHED).map(blockText));
    // …and the paragraph break is drawn as a BREAK: the second block is
    // block-level while the first stays on the trait's own line.
    const blocks = screen.getAllByTestId('text-block');
    expect(blocks[0]?.className).not.toContain('block');
    expect(blocks[1]?.className).toContain('block');
    // The line break inside the second block is carried by the text itself
    // (`whitespace-pre-line` draws it) — never split into a third element.
    expect(blocks[1]?.className).toContain('whitespace-pre-line');
  });

  it('the PDF prints one run per block, in order, with the line break inside its run', () => {
    const box = statBoxContent(paragraphBlock(), 'Cave Fisher');
    const runs = runsOf(box);
    const paragraphs = textBlocks(PARAGRAPHED).map(blockText);
    for (const paragraph of paragraphs) expect(runs).toContain(paragraph);
    // The whole body is NEVER one run (that was the wall of text)…
    const json = JSON.stringify(box);
    expect(json).not.toContain(JSON.stringify(PARAGRAPHED).slice(1, -1));
    // …while the single newline DID stay inside its own run.
    expect(json).toContain(`"text":${JSON.stringify(paragraphs[1] ?? '')}`);
    // And the app and the PDF agree on the sequence the rule produced.
    expect(runs.filter((run) => paragraphs.includes(run))).toEqual(paragraphs);
  });

  it('every section still prints, in the same order, after the block change', () => {
    const block = statBlockSchema.parse({
      ...paragraphBlock(),
      actions: [{ name: 'Mandible', text: 'Melee: +12 to hit.' }],
      reactions: [{ name: 'Reactive Snap', text: 'Strike a creature that enters its reach.' }],
      legendary: [{ name: 'Skitter Away', text: 'Stride without provoking reactions.' }],
      extras: { Perception: '+11' },
    });
    const runs = runsOf(statBoxContent(block, 'Cave Fisher'));
    const order = (needle: string): number => {
      const index = runs.findIndex((run) => run.includes(needle));
      // A section that stopped printing has no run at all — RED, not silent.
      expect(runs.some((run) => run.includes(needle))).toBe(true);
      return index;
    };
    // The sections print in the box's own order — the labeled column first
    // (abilities, then `extras`), then the named sections in source order —
    // and every one of them survives, with its own label run intact.
    expect(order('Perception')).toBeLessThan(order('Grasping Antennae'));
    expect(order('Grasping Antennae')).toBeLessThan(order('Mandible'));
    expect(order('Mandible')).toBeLessThan(order('Reactive Snap'));
    expect(order('Reactive Snap')).toBeLessThan(order('Skitter Away'));
    for (const label of [
      'Grasping Antennae: ',
      'Mandible: ',
      'Reactive Snap: ',
      'Skitter Away: ',
      'Perception: ',
    ]) {
      expect(runs).toContain(label);
    }
    // The paragraph body printed under its own name, and the label run did not
    // swallow it.
    expect(runs).toContain('It hunts by vibration.');
  });
});

describe('a row generated BEFORE the change renders with paragraphs after it', () => {
  it('reads a stored, multi-paragraph row back and draws its paragraphs — writing nothing', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
    const created = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Pre-change Zombie',
      data: { appearance: '', personality: '', statBlock: paragraphBlock() },
    });

    // The row as STORED (parse-on-read — the bytes the repo hands a renderer).
    const stored = await getArtifact(created.id);
    if (stored?.kind !== 'npc' || stored.data.statBlock === null) {
      throw new Error('the seeded npc row must read back with its stat block');
    }
    const beforeBytes = JSON.stringify(stored);
    // The stored TEXT is untouched by the fix: a blank line, no block markers.
    expect(stored.data.statBlock.traits[0]?.text).toBe(PARAGRAPHED);

    // A pre-change row renders as paragraphs NOW, with no migration and no
    // rewrite: the same stored bytes, through the one rule.
    render(<StatBlockCard statBlock={stored.data.statBlock} name={stored.name} />);
    expect(screen.getAllByTestId('text-block').map((node) => node.textContent)).toEqual(
      textBlocks(PARAGRAPHED).map(blockText),
    );
    // …and in the PDF too (the box both exporters share).
    expect(runsOf(statBoxContent(stored.data.statBlock, stored.name))).toContain(
      'The antennae drag the shallows.\nIt cannot see you.',
    );

    // NOTHING was written: no bytes, no content hash, no citation (docs/12
    // §Storage; docs/11 D2/D3 — the render is a read).
    const after = await getArtifact(created.id);
    expect(JSON.stringify(after)).toBe(beforeBytes);
  }, 20_000);
});

describe('the single-artifact GM export draws the SAME blocks (docs/17 row 146, docs/18 §5)', () => {
  /**
   * The debt docs/18 §5 held: `lib/pdfExport.statBlockSection` /
   * `dataSections` rendered an npc's-authored `appearance`/`personality` and a
   * trait body with its OWN `labelValue`/`named` rows, one run per entry, so a
   * multi-paragraph value printed as a blob on THAT path alone. These pins hold
   * the fold: the export now reaches the ONE rule, a single-block value is
   * BYTE-IDENTICAL to the pre-fold node, and the other label/value rows are
   * untouched.
   */

  /** A second paragraph and a line break inside a third — never one blob. */
  const PROSE = 'Hooded and cold.\n\nIt waits by the ford.\nIt does not blink.';

  /** A campaign-owned id for these rows (the factory demands a real uuid). */
  const CAMPAIGN = newId();

  /** The definition's first node whose JSON contains `needle` — the same
   *  "find the node, don't re-derive the document" read the layout suite uses. */
  function nodeContaining(definition: { content: unknown }, needle: string): object {
    const found = (definition.content as object[]).find((node) =>
      JSON.stringify(node).includes(needle),
    );
    if (found === undefined) throw new Error(`no node carries ${needle}`);
    return found;
  }

  function npc(overrides: {
    appearance?: string;
    personality?: string;
    traits?: { name: string; text: string }[];
  }) {
    return createArtifactRow({
      campaignId: CAMPAIGN,
      kind: 'npc',
      name: 'Ford Warden',
      data: {
        appearance: overrides.appearance ?? '',
        personality: overrides.personality ?? '',
        statBlock: statBlockSchema.parse({
          ...paragraphBlock(),
          traits: overrides.traits ?? [{ name: 'Cold Focus', text: 'It does not blink.' }],
        }),
      },
    });
  }

  it('a multi-paragraph appearance prints as SEPARATE blocks, never one blob (pin 1)', () => {
    const definition = buildGmNotesDefinition(npc({ appearance: PROSE }));
    const node = nodeContaining(definition, 'Hooded and cold.');

    // BEFORE (the defect): ONE `columns` node whose value run carried the whole
    // blob — the definition's JSON held `Hooded and cold.\n\nIt waits…`. AFTER:
    // no single run carries a blank line any more.
    expect(JSON.stringify(definition.content)).not.toContain('Hooded and cold.\\n\\n');
    // The label rides the first block, once — never repeated per paragraph.
    expect(node).toEqual({
      columns: [
        { text: 'Appearance:', style: 'label', width: 110 },
        { text: 'Hooded and cold.', style: 'value' },
      ],
    });
    // The later blocks are nodes of their own, indented into the value column,
    // and the SINGLE newline inside the last block stayed a line break.
    expect(definition.content as object[]).toContainEqual({
      text: 'It waits by the ford.\nIt does not blink.',
      style: 'value',
      margin: [110, 0, 0, 0],
    });
  });

  it('a multi-paragraph trait body prints as separate blocks, the bold name on the first (pin 1)', () => {
    const definition = buildGmNotesDefinition(
      npc({
        traits: [{ name: 'Cold Focus', text: 'It does not blink.\n\nIts hands stay still.' }],
      }),
    );
    // No single run carries the whole body any more…
    expect(JSON.stringify(definition.content)).not.toContain(
      'It does not blink.\\n\\nIts hands stay still.',
    );
    // …the bold `Name. ` leads the first block…
    expect(definition.content as object[]).toContainEqual({
      text: [{ text: 'Cold Focus. ', bold: true }, { text: 'It does not blink.' }],
      style: 'value',
    });
    // …and the later block is a node of its own, indented into the value column.
    expect(definition.content as object[]).toContainEqual({
      text: 'Its hands stay still.',
      style: 'value',
      margin: [110, 0, 0, 0],
    });
  });

  it('a SINGLE-block value is BYTE-IDENTICAL to the pre-fold node (pin 2)', () => {
    const definition = buildGmNotesDefinition(
      npc({ appearance: 'Soot-stained', personality: 'Cruel' }),
    );
    const appearance = nodeContaining(definition, 'Appearance:');
    const personality = nodeContaining(definition, 'Personality:');
    // The exact node this template printed before the fold: one `columns` node,
    // the value as ONE run, no margin and no continuation node.
    expect(appearance).toEqual({
      columns: [
        { text: 'Appearance:', style: 'label', width: 110 },
        { text: 'Soot-stained', style: 'value' },
      ],
    });
    expect(personality).toEqual({
      columns: [
        { text: 'Personality:', style: 'label', width: 110 },
        { text: 'Cruel', style: 'value' },
      ],
    });
    // The single-block trait entry is the ONE run it always was — the fold did
    // not split it and did not add a continuation node.
    expect(definition.content as object[]).toContainEqual({
      text: [{ text: 'Cold Focus. ', bold: true }, { text: 'It does not blink.' }],
      style: 'value',
    });
  }, 20_000);

  it('the other label/value rows keep their ONE-column shape (pin 4)', () => {
    const pc = createArtifactRow({
      campaignId: CAMPAIGN,
      kind: 'pc',
      name: 'Marek',
      data: {
        playerName: 'Ada',
        statBlock: null,
        currentHp: 12,
        initiativeOverride: 3,
        notes: 'Keeps watch.',
      },
    });
    const content = buildGmNotesDefinition(pc).content as object[];

    // A NON-prose row: one node, the label in the first column and the value in
    // the second, no margin — the shape this slice promised not to touch.
    expect(content).toContainEqual({
      columns: [
        { text: 'Player:', style: 'label', width: 110 },
        { text: 'Ada', style: 'value' },
      ],
    });
    expect(content).toContainEqual({
      columns: [
        { text: 'Current HP:', style: 'label', width: 110 },
        { text: '12', style: 'value' },
      ],
    });
    // The label appears ONCE (a blank-line split of this line would repeat it).
    const dump = JSON.stringify(content);
    expect(dump.split('"text":"Player:"').length - 1).toBe(1);
    expect(dump).not.toContain('"text":"Player:"},"value"');
    // A NULL initiative override is still the pre-existing empty-value rule:
    // NO row at all, never an empty one. Both arms are in one artifact kind, so
    // the arms DIFFER rather than restating one document twice.
    const absent = createArtifactRow({
      campaignId: CAMPAIGN,
      kind: 'pc',
      name: 'Marek',
      data: { playerName: '', statBlock: null, currentHp: 12, initiativeOverride: null, notes: '' },
    });
    const absentDump = JSON.stringify(buildGmNotesDefinition(absent).content);
    expect(absentDump).not.toContain('Initiative bonus');
    expect(absentDump).not.toContain('Player:');
    // The player handout has no structured data at all — unchanged by the fold.
    const handout = JSON.stringify(buildPlayerHandoutDefinition(pc).content);
    expect(handout).not.toContain('Player:');
    expect(handout).not.toContain('Cold Focus');
  });
});

describe('EXACTLY ONE text→blocks implementation (AGENTS rule 4, made mechanical)', () => {
  /** The files allowed to know the seam, and in what role. A new consumer must
   * edit this list — deliberately — rather than add a second rule. */
  const REGISTERED: Record<string, string> = {
    'lib/textBlocks.ts': 'the rule itself',
    'components/text-blocks.tsx': 'the app presenter (draws what the rule says)',
    'lib/modulePdf.ts': 'the PDF consumer (`labeledSection`, so the roster box and every prose field)',
    'features/campaign/components/stat-block.tsx': 'the reader/stat-block consumer',
    'lib/pdfExport.ts':
      'the single-artifact PDF consumer (`labelValue`/`named`, so the GM export’s own stat-block prose)',
  };

  it('the rule is defined ONCE and only the registered consumers reach it', () => {
    const files = sourceFiles();
    const definition = files.filter((file) => file.code.includes('export function textBlocks'));
    expect(definition.map((file) => file.path)).toEqual(['lib/textBlocks.ts']);

    const reaching = files
      .filter((file) => /textBlocks\(|<TextBlocks/.test(file.code))
      .map((file) => file.path)
      .sort();
    expect(reaching).toEqual(Object.keys(REGISTERED).sort());
  });

  it('neither consumer splits text into paragraphs of its own', () => {
    for (const path of [
      'lib/modulePdf.ts',
      'lib/pdfExport.ts',
      'features/campaign/components/stat-block.tsx',
      'components/text-blocks.tsx',
    ]) {
      const file = sourceFiles().find((entry) => entry.path === path);
      expect(file).not.toBeUndefined();
      const code = file?.code ?? '';
      // The consumer reaches the seam (the presenter mounts `<TextBlocks>`,
      // the PDF calls the rule).
      expect(/textBlocks\(|<TextBlocks/.test(code)).toBe(true);
      // No second paragraph rule: no blank-line split, no `\n\n` split, no
      // hand-rolled paragraph regex.
      expect(code).not.toMatch(/split\(\s*['"`]\\n\\n/);
      expect(code).not.toMatch(/split\(\s*\/\\n\{2,\}/);
      expect(code).not.toMatch(/\\n\{2,\}\//);
    }
  });

  it('the presenter holds no splitting logic at all (it draws blocks)', () => {
    const presenter = sourceFiles().find(
      (entry) => entry.path === 'components/text-blocks.tsx',
    );
    const code = presenter?.code ?? '';
    expect(code).toContain('textBlocks(');
    expect(code).toContain('blockText(');
    expect(code).not.toContain('.split(');
  });
});
