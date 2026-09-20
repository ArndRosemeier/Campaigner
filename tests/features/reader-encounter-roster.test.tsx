import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { artifactPath, modulePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  ruleChunkSchema,
  stampNewEntity,
  statBlockSchema,
  type AnyArtifact,
  type Campaign,
  type Id,
  type Module,
  type MonsterEntry,
  type StatBlock,
} from '@/domain';
import { sha256Hex } from '@/lib/hash';
import { buildModuleDefinition } from '@/lib/modulePdf';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * THE READER HALF of the owner's answer (docs/17 row 146, docs/11 §What a
 * roster row PRINTS): *"Keep the jump, and list the encounter's mobs below its
 * row in the reader's entity panel."*
 *
 * Driven through the REAL reader (`ModuleReaderPage` via the app router), never
 * a component in isolation, because the two halves being pinned are the PAGE's
 * behaviour:
 *
 * - the encounter row opens the same peek card as a prose chip, without changing
 *   the module URL; the card keeps the explicit workspace action;
 * - the card's shared roster panel carries each mob's reference and numbers, and
 *   a citation nothing can resolve stays LOUD by name with no box.
 *
 * The reference itself is not composed here: it is
 * `domain/encounterResolve.rosterReferenceFor`'s own line, rendered by the ONE
 * roster panel every surface mounts.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

// Only the LLM entry point is mocked — mounting the reader must never dial out.
vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));

const FORD = 'Ford Ambush';
const CITED = 'Cave Fisher';
const NAME_ONLY = 'Harbour Thug';
/** What the CITED mob carries — printed by the reader AND by the module book. */
const CITED_TREASURE = 'Pouch: 5 gp, a silver bell';
/** The ENCOUNTER's own line — a different string, so the two sources can never
 * be confused in an assertion about which one a surface printed. */
const ENCOUNTER_TREASURE = 'a chained grimoire on the altar';

function citedStatBlock(): StatBlock {
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
    senses: 'darkvision',
    languages: '',
    traits: [{ name: 'Grasping Antennae', text: 'Reach 10 feet.' }],
    actions: [{ name: 'Mandible', text: 'Melee: +12 to hit.' }],
    reactions: [{ name: 'Reactive Snap', text: 'Strike a creature that enters its reach.' }],
    legendary: [],
    extras: { Perception: '+11' },
  });
}

/** A citation row, as the generator writes it. */
function citedEntry(chunkId: Id, contentHash: string): MonsterEntry {
    void chunkId;
    void contentHash;
  return {
    name: CITED,
    count: 1,
    notes: '',
    // What ONE instance carries — the GM checklist text the reader's roster row
    // and the module book both print through the SAME domain rule (docs/17 row
    // 159). The name-only mob below carries nothing and prints no line at all.
    treasure: CITED_TREASURE,
    source: { type: 'none' as const },
  };
}

/**
 * The reader's own seed: a campaign, an ingested book whose chunk carries the
 * creature's numbers (or does NOT — the statless variant), a module whose
 * premise names the encounter, and the encounter's roster.
 */
async function seedReader(options: { statBlock: StatBlock | null }): Promise<{
  campaignId: Id;
  moduleId: Id;
  encounterId: Id;
  /** The module row and its scoped artifacts — the module BOOK's own input, so
   * the reader's roster row can be compared with the page it will be printed on. */
  module: Module;
  artifacts: AnyArtifact[];
}> {
  await seedBuiltInPersonas();
  const campaign: Campaign = await createCampaign({ name: 'Ember', system: 'pathfinder2e' });
  const rulebook = await createRulebook({
    title: 'Bestiary',
    system: 'pathfinder2e',
    filename: 'bestiary.pdf',
  });
  const text = CITED;
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: rulebook.id,
    pageStart: 132,
    pageEnd: 132,
    chunkType: 'statblock',
    headingPath: [CITED],
    text,
    statBlock: options.statBlock,
    contentHash: await sha256Hex(text),
  });
  await putChunks([chunk]);

  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: FORD,
    body: 'They come up out of the water.',
    data: {
      difficulty: 'severe',
      levelHint: '4',
      monsters: [
        citedEntry(chunk.id, chunk.contentHash),
        { name: NAME_ONLY, count: 2, notes: '', treasure: '', source: { type: 'none' as const } },
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

  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'A flooded vault.',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'standard',
  });
  const module = await saveModule({
    ...draft,
    status: 'ready',
    spine: moduleSpineSchema.parse({
      premise: `They spring the [[${FORD}]] at dusk.`,
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
    campaignId: campaign.id,
    moduleId: module.id,
    encounterId: encounter.id,
    module,
    artifacts: [encounter],
  };
}

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

/** The encounter's entity row, whose click opens the shared peek card. */
async function openEncounterCard(): Promise<HTMLElement> {
  const rows = await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
  const row = rows.find((candidate) => candidate.textContent.includes(FORD));
  if (row === undefined) throw new Error(`${FORD} row not found in the entity panel`);
  await userEvent.setup().click(row);
  const peek = await screen.findByTestId('peek-modal', {}, { timeout: 10_000 });
  return within(peek).getByTestId('play-encounter-card');
}

/** The shared roster panel inside EncounterCard, once roster resolution settles. */
async function findMobs(card: HTMLElement): Promise<HTMLElement> {
  const panel = await within(card).findByTestId('stat-blocks-panel', {}, { timeout: 10_000 });
  await waitFor(
    () => {
      expect(within(panel).getAllByTestId('roster-entry').length).toBeGreaterThan(0);
    },
    { timeout: 10_000 },
  );
  return panel;
}

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

/**
 * The TREASURE line the module BOOK prints under ONE roster row — read from that
 * row's own block (the `stack` whose first text array starts with the mob's
 * `Name ×count` label), never from the formatter the reader also calls: the two
 * surfaces are compared with each other, not each with the rule. `null` means
 * the book printed no such line for that row.
 */
function printedBookTreasure(node: unknown, label: string): string | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = printedBookTreasure(child, label);
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
    if (Array.isArray(text) && runsOf(text).join('').startsWith(label)) {
      for (const child of stack) {
        const line = runsOf(child).join('');
        if (line.startsWith('Treasure: ')) return line;
      }
      return null;
    }
  }
  for (const value of Object.values(record)) {
    const found = printedBookTreasure(value, label);
    if (found !== null) return found;
  }
  return null;
}

beforeEach(clearDatabase);

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('the module reader opens the shared encounter card', () => {
  it('lists every mob with its reference and numbers, and workspace opening stays explicit', async () => {
    const { campaignId, moduleId, encounterId } = await seedReader({
      statBlock: citedStatBlock(),
    });
    renderAppAt(modulePath(campaignId, moduleId));

    const card = await openEncounterCard();
    const mobs = await findMobs(card);

    // EVERY mob of the roster is listed, in roster order.
    const entries = within(mobs).getAllByTestId('roster-entry');
    expect(entries.map((entry) => entry.getAttribute('data-name'))).toEqual([CITED, NAME_ONLY]);

    // The CITED mob's reference is the ONE formatter's line — the same words
    // the module PDF and the GM export print (docs/17 row 144) — with the cited
    // chunk's OWN numbers under it.
    const citedRow = entries[0];
    if (citedRow === undefined) throw new Error('the cited row must be listed');
    // EXACT bytes, not `toHaveTextContent`'s SUBSTRING match: a decoration
    // appended to the line (the very blindness the differential pin in
    // `lib/roster-reference-parity.test.ts` was tightened for) must fail here.
    expect(within(citedRow).getByTestId('roster-reference').textContent).toBe(
      ' — Bestiary p.132',
    );
    expect(within(citedRow).getByText('Grasping Antennae.')).toBeInTheDocument();
    expect(within(citedRow).getByText('Reactive Snap.')).toBeInTheDocument();
    expect(within(citedRow).getByText('18')).toBeInTheDocument();

    // The NAME-ONLY mob is listed too, with the formatter's own statement —
    // never a dropped row and never a placeholder.
    const nameOnlyRow = entries[1];
    if (nameOnlyRow === undefined) throw new Error('the name-only row must be listed');
    expect(within(nameOnlyRow).getByTestId('roster-reference').textContent).toBe(
      ' — no stats: this roster entry names the creature without a citation',
    );

    // The reader stays mounted and the card's explicit action owns workspace
    // navigation.
    expect(window.location.pathname).toBe(modulePath(campaignId, moduleId));
    await userEvent.setup().click(screen.getByTestId('peek-open-workspace'));
    await waitFor(
      () => {
        expect(window.location.pathname).toBe(artifactPath(campaignId, encounterId));
      },
      { timeout: 10_000 },
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('keeps a citation nothing can resolve LOUD, by name, with no box', async () => {
    const { campaignId, moduleId } = await seedReader({ statBlock: null });
    renderAppAt(modulePath(campaignId, moduleId));

    const card = await openEncounterCard();
    const mobs = await findMobs(card);
    const citedRow = within(mobs).getAllByTestId('roster-entry')[0];
    if (citedRow === undefined) throw new Error('the cited row must be listed');

    // The NAMED reason, in the formatter's own words — never an empty row and
    // never a placeholder standing in for the numbers (AGENTS rule 1).
    expect(within(citedRow).getByTestId('roster-reference').textContent).toBe(
      ' — missing ref (Cave Fisher)',
    );
    // …and NO stat box: the assertion is an ABSENCE, so an empty or invented
    // block would fail it.
    expect(within(citedRow).queryByText('AC')).not.toBeInTheDocument();
    expect(within(citedRow).queryByText('Grasping Antennae.')).not.toBeInTheDocument();
    // The name-only row still says what is true about itself.
    const nameOnlyRow = within(mobs).getAllByTestId('roster-entry')[1];
    if (nameOnlyRow === undefined) throw new Error('the name-only row must be listed');
    expect(within(nameOnlyRow).getByTestId('roster-reference').textContent).toBe(
      ' — no stats: this roster entry names the creature without a citation',
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('shows what a mob carries, in the book’s own words — and nothing for a mob that carries nothing', async () => {
    const { campaignId, moduleId, module, artifacts } = await seedReader({
      statBlock: citedStatBlock(),
    });
    renderAppAt(modulePath(campaignId, moduleId));

    const card = await openEncounterCard();
    const mobs = await findMobs(card);
    const entries = within(mobs).getAllByTestId('roster-entry');
    const citedRow = entries[0];
    const nameOnlyRow = entries[1];
    if (citedRow === undefined || nameOnlyRow === undefined) {
      throw new Error('both roster rows must be listed');
    }

    // The reader prints the mob's own authored text through the domain rule…
    const readerLine = within(citedRow).getByTestId('roster-treasure').textContent;
    expect(readerLine).toBe(`Treasure: ${CITED_TREASURE}`);

    // …and the MODULE BOOK, built from the same rows, prints the SAME line under
    // the same mob. The two are compared with EACH OTHER — each is extracted
    // from its own surface (the DOM / the definition), never read back from the
    // formatter both call, so a reader that reworded the line reds this file.
    const definition = buildModuleDefinition({ module, artifacts });
    const bookLine = printedBookTreasure(definition, `${CITED} ×1`);
    expect(bookLine).not.toBeNull();
    expect(bookLine).toBe(readerLine);
    // Anchored to the words the seed authored, so a rule that answered the SAME
    // wrong string on both surfaces still fails here.
    expect(bookLine).toBe(`Treasure: ${CITED_TREASURE}`);

    // The mob that carries nothing renders NO element — not an empty span and
    // not a label standing over a blank value (AGENTS rule 1) — in the reader…
    expect(within(nameOnlyRow).queryByTestId('roster-treasure')).not.toBeInTheDocument();
    expect(printedBookTreasure(definition, `${NAME_ONLY} ×2`)).toBeNull();
    // …and the encounter's OWN treasure is not what either surface printed here
    // (the two sources are separate lines, never one merged string).
    expect(readerLine).not.toContain(ENCOUNTER_TREASURE);
    await flushAsyncUpdates();
  }, 20_000);
});

/**
 * EXACTLY ONE reference rule in the app too (AGENTS rule 4, made mechanical):
 * the reader mounts the shared roster panel and composes nothing itself, and
 * that panel renders the two domain seams rather than its own strings.
 */
describe('EXACTLY ONE roster reference implementation in the app', () => {
  /** Comments stripped: a rule is what EXECUTES, not what is documented. */
  function code(relative: string): string {
    const path = fileURLToPath(new URL('../../' + relative, import.meta.url));
    return readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  const PANEL = 'src/features/campaign/components/monster-source.tsx';
  const READER_PANEL = 'src/features/modules/entity-panel.tsx';

  it('the sidebar has no inline roster renderer or expansion block', () => {
    const reader = code(READER_PANEL);
    expect(reader).not.toContain('MonsterStatblocksPanel');
    expect(reader).not.toContain('entity-encounter-mobs');
    // The sidebar owns no reference vocabulary or second resolution either.
    expect(reader).not.toContain('rosterReferenceFor');
    expect(reader).not.toContain('rosterStatBlockFor');
    expect(reader).not.toContain('resolveMonsterEntr');
    expect(reader).not.toContain('missing ref (');
    expect(reader).not.toContain('no stats: this roster entry names');
    expect(reader).not.toContain('see ${');
  });

  it('the reader and prose chips use the same encounter card seam', () => {
    const page = code('src/features/modules/ModuleReaderPage.tsx');
    const peek = code('src/features/modules/peek-modal.tsx');
    expect(page).toContain('setPeekId(artifact.id)');
    expect(page).not.toContain("artifact.kind === 'encounter'");
    // The peek card gets the SAME pool AND the SAME breadcrumb-push callback
    // its own `[[…]]` body chips use (docs/17 row 217) — so the encounter's
    // model-prose summary and its mobs' notes resolve and open like every other
    // wiki token on the surface. Before row 217 this exact assertion named the
    // one-line form without `onOpenArtifact`; the HTML-comment state it guards
    // is unchanged (the peek modal is still the only encounter card seam).
    expect(peek).toMatch(
      /<EncounterCard[\s\S]*?artifacts=\{artifacts\}[\s\S]*?onOpenArtifact=\{onOpenArtifact\}[\s\S]*?showWriterModel/,
    );
  });

  it('the shared panel renders the domain rule, not strings of its own', () => {
    const panel = code(PANEL);
    expect(panel).toContain('rosterReferenceFor');
    expect(panel).toContain('rosterStatBlockFor');
    expect(panel).toContain('resolveMonsterEntries');
    // No second spelling of the reference vocabulary anywhere in the panel (the
    // domain module is the only place those sentences live).
    expect(panel).not.toContain('no stats: this roster entry names');
    expect(panel).not.toContain('unresolved citation');
    expect(panel).not.toContain('Bestiary p.');
    // …and no hand-built reference either: no template that appends an origin
    // to a roster line.
    expect(panel).not.toContain('entry.origin`');
    expect(panel).not.toContain('${entry.origin}');
  });

  it('the panel prints a mob’s TREASURE through the domain rule too (docs/17 row 159)', () => {
    const panel = code(PANEL);
    // The line comes from the ONE rule the books render…
    expect(panel).toContain('rosterTreasureFor');
    // …and the panel composes no label of its own and takes no emptiness
    // decision by reading the roster entry's raw field: `rosterTreasureFor`'s
    // `null` is the whole answer, so an empty span or a label over a blank
    // value has nowhere to come from (AGENTS rules 1 and 4).
    expect(panel).not.toContain('Treasure: ');
    expect(panel).not.toContain('monster.treasure');
    expect(panel).not.toContain('entry.treasure');
  });
});
