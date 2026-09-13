import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';


import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { statBlockSchema, type StatBlock } from '@/domain';
import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { StatBlockCard } from '@/features/campaign/components/stat-block';
import { statBoxContent } from '@/lib/modulePdf';
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

describe('EXACTLY ONE text→blocks implementation (AGENTS rule 4, made mechanical)', () => {
  /** The files allowed to know the seam, and in what role. A new consumer must
   * edit this list — deliberately — rather than add a second rule. */
  const REGISTERED: Record<string, string> = {
    'lib/textBlocks.ts': 'the rule itself',
    'components/text-blocks.tsx': 'the app presenter (draws what the rule says)',
    'lib/modulePdf.ts': 'the PDF consumer (`labeledSection`, so the roster box and every prose field)',
    'features/campaign/components/stat-block.tsx': 'the reader/stat-block consumer',
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
