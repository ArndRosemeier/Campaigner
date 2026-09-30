import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type AnyArtifact,
  type Module,
} from '@/domain';
import { buildModuleDefinition } from '@/lib/modulePdf';
import { clearDatabase } from '../db/helpers';

/**
 * PER-MOB TREASURE REACHES THE DOCUMENT (docs/17 row 159, docs/11 §Room keys).
 *
 * The defect, as measured: a roster entry's `treasure` was AUTHORED in the
 * encounter editor, STORED on `MonsterEntry.treasure`, frozen onto the seeded
 * tokens for the GM's token card and sent to the canvas chat's details block —
 * and the module PDF's treasure ledger read the ENCOUNTER's own `treasure` field
 * and nothing else. A GM who typed "Pouch: 5 gp, a silver bell" on every Bandit
 * got a token card, an editor field and a chat line, and an EMPTY treasure
 * ledger: the encounter was skipped whole because its OWN field was empty.
 *
 * These pins are the ledger's own contract, and they are written on the ROWS a
 * GM reads rather than on a bare word anywhere in the document:
 *
 * - a mob's treasure is a row of its OWN, LABELLED by the creature that carries
 *   it — never merged into the encounter's line (which stays the encounter's);
 * - a mob carrying nothing adds NO row and NO line, and never a label standing
 *   over a blank value;
 * - an encounter whose ONLY treasure is on its roster DOES produce a ledger —
 *   the fix's essence, and the case that produced no ledger at all before;
 * - an encounter with no treasure anywhere still produces none (the behaviour
 *   that must survive);
 * - the PLAYER document carries none of it: not the ledger, not the encounter
 *   section's mob lines.
 *
 * The surfaces that must agree with each other are pinned where they can be
 * compared: `roster-reference-parity.test.ts` (module book vs the single-artifact
 * GM export, both real definitions) and `reader-encounter-roster.test.tsx` (the
 * reader's roster row's DOM vs the module book's own printed line).
 */

/** Every text run of a pdfmake node, in document order. */
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

function textOf(node: unknown): string {
  return runsOf(node).join('');
}

/** A table cell read as text (a cell may be a string or a text node). */
function cellText(cell: unknown): string {
  if (typeof cell === 'string') return cell;
  return textOf(cell);
}

interface Ledger {
  header: string[];
  rows: string[][];
}

/**
 * The treasure LEDGER a document prints — found by its own header cells, never
 * by a guess about position. `null` means the document prints no ledger, which
 * every caller below treats as a fact to assert rather than as an empty table
 * (an extraction that answered `[]` would make "the mob is absent" pass on a
 * document that has no ledger at all).
 */
function ledgerOf(node: unknown): Ledger | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = ledgerOf(child);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null) return null;
  const record = node as Record<string, unknown>;
  const table = record.table as { body?: unknown[][] } | undefined;
  const body = table?.body;
  if (Array.isArray(body)) {
    const header = (body[0] ?? []).map(cellText);
    if (header[0] === 'Encounter' && header[1] === 'Treasure') {
      return { header, rows: body.slice(1).map((row) => row.map(cellText)) };
    }
  }
  for (const value of Object.values(record)) {
    const found = ledgerOf(value);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The block ONE roster row prints in the encounter section: the `stack` whose
 * first text array starts with the mob's own `Name ×count` label. `null` means
 * the document printed no such block.
 */
function mobBlock(node: unknown, label: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = mobBlock(child, label);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null) return null;
  const record = node as Record<string, unknown>;
  const stack = record.stack;
  if (Array.isArray(stack)) {
    const first = stack[0] as Record<string, unknown> | undefined;
    const text = first?.text;
    if (Array.isArray(text) && textOf(text).startsWith(label)) return record;
  }
  for (const value of Object.values(record)) {
    const found = mobBlock(value, label);
    if (found !== null) return found;
  }
  return null;
}

/** Whether the document prints the treasure chapter at all (its own node id). */
function printsTreasureChapter(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(printsTreasureChapter);
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  if (record.id === 'node-treasure') return true;
  return Object.values(record).some(printsTreasureChapter);
}

/** The label a mob's own encounter-section block carries, as the book prints it. */
function mobLabel(name: string, count: number): string {
  return `${name} ×${count}`;
}

interface Seed {
  /** Mentions all three encounters — the document that must carry every row. */
  moduleAll: Module;
  /** Mentions ONLY the cellar, whose roster carries nothing. */
  moduleEmpty: Module;
  artifacts: AnyArtifact[];
}

const ENCOUNTER_TREASURE = 'silver bell charm';
const CULTIST_TREASURE = 'Pouch: 5 gp, a silver bell';
const GHOUL_TREASURE = 'A gold tooth on a leather cord';

async function seed(): Promise<Seed> {
  const campaign = await createCampaign({ name: 'Treasure Campaign', system: 'pathfinder2e' });

  const ambush = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    body: 'They come up out of the water.',
    data: {
      difficulty: 'severe',
      levelHint: '', partyLevel: 4,
      monsters: [
        { name: 'Cultist', count: 4, notes: 'netters', treasure: CULTIST_TREASURE, source: { type: 'none' as const } },
        // Carries NOTHING: the mob that must contribute no row and no line.
        { name: 'Harbour Thug', count: 2, notes: '', treasure: '', source: { type: 'none' as const } },
      ],
      terrain: 'wet planks',
      tactics: 'drag them under',
      treasure: ENCOUNTER_TREASURE,
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });
  // NO encounter-level treasure at all: the whole ledger row for this encounter
  // comes from its roster — the case that used to print nothing.
  const vault = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'The Drowned Vault',
    body: 'Cold water to the waist.',
    data: {
      difficulty: 'moderate',
      levelHint: '', partyLevel: 3,
      monsters: [
        { name: 'Ghoul', count: 3, notes: '', treasure: GHOUL_TREASURE, source: { type: 'none' as const } },
      ],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });
  // Nothing anywhere: neither the encounter nor its roster holds treasure.
  const cellar = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Empty Cellar',
    body: 'Bare shelves.',
    data: {
      difficulty: 'trivial',
      levelHint: '', partyLevel: 1,
      monsters: [
        { name: 'Rat', count: 5, notes: '', treasure: '   ', source: { type: 'none' as const } },
      ],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      layout: null,
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    },
  });

  const moduleFor = async (name: string, premise: string): Promise<Module> =>
    saveModule({
      ...createModule({
        campaignId: campaign.id,
        title: name,
        concept: 'A wet hole in the ground.',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
      }),
      spine: moduleSpineSchema.parse({
        premise,
        themes: [],
        partPlan: [{ title: 'The Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: 'The party climbs down into the wet dark.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    });

  return {
    moduleAll: await moduleFor(
      'Beneath the Docks',
      `They spring the [[Pier Ambush]] at dusk, then the [[The Drowned Vault]], ` +
        `and the [[Empty Cellar]] waits with nothing in it.`,
    ),
    moduleEmpty: await moduleFor('The Empty Cellar', 'Only the [[Empty Cellar]] is here.'),
    artifacts: [ambush, vault, cellar],
  };
}

beforeEach(clearDatabase);

describe('the treasure ledger carries the roster’s treasure, labelled per mob (docs/17 row 159)', () => {
  it('prints ONE row per source — the encounter’s own line, and a labelled line per mob that carries something', async () => {
    const seeded = await seed();
    const definition = buildModuleDefinition({
      module: seeded.moduleAll,
      artifacts: seeded.artifacts,
    });

    const ledger = ledgerOf(definition);
    expect(ledger).not.toBeNull();
    if (ledger === null) throw new Error('the ledger must print for this document');

    // EXACT rows, in one equality: the encounter's own line first (unchanged,
    // bare encounter name), then one row per mob THAT CARRIES SOMETHING, labelled
    // `<encounter> · <mob> ×count`; `Harbour Thug` carries nothing and is absent;
    // the `Empty Cellar` contributes no row at all. An exporter that merged the
    // two sources into one string, mislabelled a carrier or emitted an empty row
    // fails here.
    expect(ledger.header).toEqual(['Encounter', 'Treasure']);
    expect(ledger.rows).toEqual([
      ['Pier Ambush', ENCOUNTER_TREASURE],
      [`Pier Ambush · ${mobLabel('Cultist', 4)}`, CULTIST_TREASURE],
      [`The Drowned Vault · ${mobLabel('Ghoul', 3)}`, GHOUL_TREASURE],
    ]);
    // NON-VACUITY, both sources: the encounter's field is in the ledger AND so
    // is a mob's — the equality above would also hold for a document that
    // dropped one of them only if it dropped the row, which it does not.
    expect(textOf(definition)).toContain(ENCOUNTER_TREASURE);
    expect(textOf(definition)).toContain(CULTIST_TREASURE);

    // A mob with no treasure adds NO label over a blank: every ledger cell is
    // non-empty, and the ONLY labelled treasure runs the document prints are the
    // carrying mobs' own lines plus ONE bare `Treasure: ` — the ambush's own
    // labeled section, whose value is the run beside it (the book's
    // `labeledSection` shape). A mob carrying nothing would appear here as a
    // SECOND bare label with nothing after it.
    for (const row of ledger.rows) {
      expect(row[0] ?? '').not.toBe('');
      expect((row[1] ?? '').trim()).not.toBe('');
    }
    const labelled = runsOf(definition).filter((run) => run.startsWith('Treasure:'));
    expect(labelled.filter((run) => run === 'Treasure: ')).toEqual(['Treasure: ']);
    expect(labelled).toContain(`Treasure: ${CULTIST_TREASURE}`);
    expect(labelled).toContain(`Treasure: ${GHOUL_TREASURE}`);
  });

  it('produces a ledger for an encounter whose ONLY treasure is on its roster', async () => {
    const seeded = await seed();
    const definition = buildModuleDefinition({
      module: seeded.moduleAll,
      artifacts: seeded.artifacts,
    });

    // The essence of the fix: `The Drowned Vault` stores NOTHING in its own
    // `treasure` field, so before this landing its whole ledger row was skipped.
    const vault = seeded.artifacts.find((row) => row.name === 'The Drowned Vault');
    const data = vault?.kind === 'encounter' ? vault.data : undefined;
    expect(data?.treasure).toBe('');
    expect(data?.monsters[0]?.treasure).toBe(GHOUL_TREASURE);

    const ledger = ledgerOf(definition);
    expect(ledger).not.toBeNull();
    expect(ledger?.rows.map((row) => row[0])).toContain(
      `The Drowned Vault · ${mobLabel('Ghoul', 3)}`,
    );
    expect(ledger?.rows.map((row) => row[1])).toContain(GHOUL_TREASURE);
  });

  it('prints the mob’s treasure in the encounter section, under the mob it belongs to', async () => {
    const seeded = await seed();
    const definition = buildModuleDefinition({
      module: seeded.moduleAll,
      artifacts: seeded.artifacts,
    });

    // The mob's OWN block carries the line — a GM reading the encounter finds
    // the pouch under the Cultist, not in a global list somewhere.
    const cultist = mobBlock(definition, mobLabel('Cultist', 4));
    expect(cultist).not.toBeNull();
    expect(textOf(cultist)).toContain(`Treasure: ${CULTIST_TREASURE}`);

    // The mob that carries nothing has NO such line in its block…
    const thug = mobBlock(definition, mobLabel('Harbour Thug', 2));
    expect(thug).not.toBeNull();
    expect(textOf(thug)).not.toContain('Treasure');
    // …and the encounters' OWN lines are still printed, separately: the ambush's
    // field is its own labeled section, never merged with the roster's lines.
    expect(textOf(definition)).toContain(`Treasure: ${ENCOUNTER_TREASURE}`);
    expect(textOf(definition)).not.toContain(`${ENCOUNTER_TREASURE} ${CULTIST_TREASURE}`);
    expect(textOf(cultist)).not.toContain(ENCOUNTER_TREASURE);
  });

  it('produces NO ledger when no printed encounter stores treasure anywhere', async () => {
    const seeded = await seed();
    const definition = buildModuleDefinition({
      module: seeded.moduleEmpty,
      artifacts: seeded.artifacts,
    });

    // Today's behaviour, pinned: no rows means no chapter, no kicker and no
    // table — never an empty ledger standing there.
    expect(ledgerOf(definition)).toBeNull();
    expect(printsTreasureChapter(definition)).toBe(false);
    expect(textOf(definition)).not.toContain('TREASURE LEDGER');
    // NON-VACUITY: the very document that must NOT carry a ledger is the one
    // printing that encounter (its section, its mob and its mob's empty field).
    expect(textOf(definition)).toContain('Empty Cellar');
    expect(textOf(definition)).toContain(mobLabel('Rat', 5));
    const rat = mobBlock(definition, mobLabel('Rat', 5));
    expect(rat).not.toBeNull();
    expect(textOf(rat)).not.toContain('Treasure');
  });

  it('carries none of it into the PLAYER document', async () => {
    const seeded = await seed();
    const input = { module: seeded.moduleAll, artifacts: seeded.artifacts };
    const gm = textOf(buildModuleDefinition(input));
    const player = textOf(buildModuleDefinition({ ...input, audience: 'player' }));

    // The GM document really does carry both sources…
    expect(gm).toContain('TREASURE LEDGER');
    expect(gm).toContain(CULTIST_TREASURE);
    expect(gm).toContain(GHOUL_TREASURE);
    expect(gm).toContain(ENCOUNTER_TREASURE);

    // …and the player's carries NONE of them: not the ledger, not the mob lines,
    // not even the encounter-level line (the field rule that already held).
    expect(player).not.toContain('TREASURE LEDGER');
    expect(printsTreasureChapter(buildModuleDefinition({ ...input, audience: 'player' }))).toBe(
      false,
    );
    expect(player).not.toContain(CULTIST_TREASURE);
    expect(player).not.toContain(GHOUL_TREASURE);
    expect(player).not.toContain(ENCOUNTER_TREASURE);
    expect(player).not.toContain('Treasure:');
    // NON-VACUITY: the encounters themselves ARE printed to the players (the
    // audience split removes treasure, not the fight).
    expect(player).toContain('Pier Ambush');
    expect(player).toContain(mobLabel('Cultist', 4));
  });
});
