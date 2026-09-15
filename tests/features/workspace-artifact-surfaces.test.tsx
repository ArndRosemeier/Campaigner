import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTES, artifactPath, modulePath, workspacePath } from '@/app/routes';
import { createAppRouter } from '@/app/router';
import {
  createArtifact,
  getAnyArtifact,
  getArtifact,
  listGlobalArtifacts,
  updateArtifact,
} from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { castCreatureAsNpc } from '@/db/creatureRepo';
import { db } from '@/db/db';
import { createModule as saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { resolveMonsterEntryWithRepos } from '@/db/monsterResolve';
import {
  blankStatBlock,
  createModule as createModuleRow,
  newId,
  npcDataSchema,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type Artifact,
} from '@/domain';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { ScopeControl } from '@/features/campaign/components/scope-control';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { NpcCard } from '@/features/play/artifact-cards';
import { sha256Hex } from '@/lib/hash';
import { resolveWikiLink } from '@/lib/wikilinks';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * PILOT MERGE (docs/17 row 176): five small test files that mount the SAME
 * background — `fake-indexeddb` + `clearDatabase()` per test + `flushAsyncUpdates()`
 * drain, driving Dexie repos and the workspace/editor React surfaces — now run
 * in ONE file, so the import/transform/jsdom-environment/setup cost is paid
 * once instead of five times.
 *
 * Merged from (one `describe` per original file, tests and assertions intact;
 * the only body edits are import aliases: moduleRepo's `createModule` is
 * `saveModule`, domain's `createModule` is `createModuleRow`):
 *   - tests/features/editor-aliases.test.tsx
 *   - tests/features/cast-row-borrowed-stats.test.tsx
 *   - tests/features/export-dialog.test.tsx
 *   - tests/features/tree-scope.test.tsx
 *   - tests/features/workspace.test.tsx
 *
 * `beforeEach(clearDatabase)` + `afterEach(cleanup)` at the top level is the
 * ONE shared setup; per-original-file extra seeding stays inside its describe.
 * None of the five uses `vi.mock`/`vi.resetModules`, so the merged file shares
 * one module registry with no mock to leak — the failure mode that made the
 * `--no-isolate` experiment red (docs/17 row 175).
 */

function renderWorkspace(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={ROUTES.workspace} element={<WorkspacePage />} />
        <Route path={ROUTES.artifact} element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

// The ONE shared setup for every describe below (all five originals started
// from an empty Dexie database and relied on the global cleanup hook; the
// explicit `cleanup()` is kept because tree-scope and workspace declared it).
beforeEach(clearDatabase);
afterEach(cleanup);

// ---------------------------------------------------------------------------
// tests/features/editor-aliases.test.tsx
// ---------------------------------------------------------------------------

/**
 * Alias chip input in the artifact editor header (08-MODULE-DESIGNER M4-A —
 * "also known as", adjacent to the tags row; docs/05 §Artifact editor).
 * Aliases are the alternate names module wiki-links resolve against:
 * added/removed through the editor like tags, deduped case-insensitively
 * against the artifact's own name and existing aliases, stored verbatim
 * (never lowercased — resolution lowercases on its own), and removal never
 * rewrites module text (08 §M4-A binding rule).
 */

const NPC_DATA = {
  appearance: 'Small, soot-stained.',
  personality: 'Manic, cheerful.',
  statBlock: null,
};

async function seedNpc(): Promise<{ npcId: string; campaignId: string }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Grix',
    summary: 'Goblin alchemist boss.',
    tags: ['goblin'],
    aliases: ['The Alchemist'],
    body: 'Meet [[The Alchemist]] at dusk.',
    data: NPC_DATA,
  });
  return { npcId: npc.id, campaignId: campaign.id };
}

/** Re-reads the npc row after the autosave debounce has had its window. */
async function loadNpc(npcId: string) {
  const row = await getArtifact(npcId);
  if (row?.kind !== 'npc') throw new Error('npc missing');
  return row;
}

describe('artifact editor alias chips', () => {
  it('adds an alias chip and persists it through autosave', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(
      <ArtifactEditor
        artifact={npc}
        campaignId={campaignId}
        campaignArtifacts={[npc]}
        campaignSystem="dnd5e"
      />,
    );

    const input = screen.getByPlaceholderText('Add alias…');
    await user.type(input, 'Grix the Wily{Enter}');

    expect(screen.getByText('Grix the Wily')).toBeInTheDocument();
    await waitFor(
      async () => {
        expect((await loadNpc(npcId)).aliases).toEqual(['The Alchemist', 'Grix the Wily']);
      },
      { timeout: 4_000 },
    );
    await flushAsyncUpdates();
  });

  it('removes an alias chip and persists the removal without touching body text', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(
      <ArtifactEditor
        artifact={npc}
        campaignId={campaignId}
        campaignArtifacts={[npc]}
        campaignSystem="dnd5e"
      />,
    );

    // Add a second alias, then remove the seeded one.
    await user.type(screen.getByPlaceholderText('Add alias…'), 'Skarn{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove alias The Alchemist' }));
    expect(screen.queryByText('The Alchemist')).toBeNull();
    expect(screen.getByText('Skarn')).toBeInTheDocument();

    await waitFor(
      async () => {
        expect((await loadNpc(npcId)).aliases).toEqual(['Skarn']);
      },
      { timeout: 4_000 },
    );
    // No cascading rewrite (08 §M4-A): removal only edits the alias list.
    expect((await loadNpc(npcId)).body).toBe(npc.body);
    await flushAsyncUpdates();
  });

  it('rejects a case-insensitive duplicate of an existing alias, keeping the stored spelling', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(
      <ArtifactEditor
        artifact={npc}
        campaignId={campaignId}
        campaignArtifacts={[npc]}
        campaignSystem="dnd5e"
      />,
    );

    await user.type(screen.getByPlaceholderText('Add alias…'), 'the alchemist,'); // comma commits

    // Exactly one chip — the seeded spelling. The lowercase spelling the
    // user typed never appears as a chip (the body textarea is not a chip).
    expect(screen.getAllByLabelText('Remove alias The Alchemist')).toHaveLength(1);
    expect(screen.queryByText('the alchemist')).toBeNull();
    await waitFor(
      async () => {
        // The original spelling is the only one — no lowercase twin stored.
        expect((await loadNpc(npcId)).aliases).toEqual(['The Alchemist']);
      },
      { timeout: 4_000 },
    );
    await flushAsyncUpdates();
  });

  it('rejects an alias equal to the artifact name (case-insensitively)', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(
      <ArtifactEditor
        artifact={npc}
        campaignId={campaignId}
        campaignArtifacts={[npc]}
        campaignSystem="dnd5e"
      />,
    );

    await user.type(screen.getByPlaceholderText('Add alias…'), 'grix{Enter}');

    expect(screen.queryByText('grix')).toBeNull();
    await waitFor(
      async () => {
        expect((await loadNpc(npcId)).aliases).toEqual(['The Alchemist']);
      },
      { timeout: 4_000 },
    );
    await flushAsyncUpdates();
  });

  it('resolves a wiki-link that only matches via a newly added alias', async () => {
    const user = userEvent.setup();
    const { npcId, campaignId } = await seedNpc();
    const npc = await loadNpc(npcId);
    render(
      <ArtifactEditor
        artifact={npc}
        campaignId={campaignId}
        campaignArtifacts={[npc]}
        campaignSystem="dnd5e"
      />,
    );

    await user.type(screen.getByPlaceholderText('Add alias…'), 'Grix the Wily{Enter}');
    await waitFor(
      async () => {
        expect((await loadNpc(npcId)).aliases).toContain('Grix the Wily');
      },
      { timeout: 4_000 },
    );

    // Before the alias existed this name had no owner; now it resolves to
    // the artifact (case-insensitively), name-first matching untouched.
    const stored = await loadNpc(npcId);
    expect(resolveWikiLink('Grix', [stored]).artifact?.id).toBe(npcId); // still the name
    const resolution = resolveWikiLink('grix the wily', [stored]);
    expect(resolution.status).toBe('resolved');
    expect(resolution.artifact?.id).toBe(npcId);
    await flushAsyncUpdates();
  });
});

// ---------------------------------------------------------------------------
// tests/features/cast-row-borrowed-stats.test.tsx
// ---------------------------------------------------------------------------

/**
 * A CITED npc row SHOWS its library creature's numbers (docs/17 row 134,
 * docs/11 D3, docs/18 §2/§4).
 *
 * The owner's report was that a named zombie cast out of a module's TEXT got a
 * portrait and nothing else — *"No text, no stat block, nothing"* — and the
 * stats half of it is NOT a data gap: the numbers exist, derived at read time
 * from the library creature the row cites (`domain/encounterResolve.
 * resolveDerivedNpcStats`, the ONE rule the encounter roster has always read).
 * They were simply drawn nowhere the owner looked, and the editor offered an
 * "Add stat block" button that the cited-row refill refuses before any model
 * call and that `npcDataSchema` refuses to keep — an affordance that could
 * never produce anything.
 *
 * These pins are the two sides of that defect and the two sides of the
 * NON-cited case that must stay byte-identical, plus the LOUD failure when the
 * library can no longer supply the creature (AGENTS rules 1/2: never a blank
 * stat area, never an invented block).
 */

/** A library creature with DISTINCTIVE numbers, so a pin asserting "the card
 * rendered something" cannot pass on a default/empty block. */
async function seedLibraryCreature(): Promise<string> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'b.pdf' });
  const text = 'Bog Zombie\nLarge undead, unaligned\nArmor Class 14\nHit Points 22';
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    bookId: book.id,
    pageStart: 4,
    pageEnd: 4,
    chunkType: 'statblock',
    headingPath: ['Bog Zombie'],
    text,
    statBlock: statBlockSchema.parse({
      system: 'dnd5e',
      level: '2',
      size: 'Large',
      creatureType: 'undead',
      ac: 14,
      acNote: '',
      hp: 22,
      hpFormula: '4d10',
      speed: '20 ft.',
      abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
      saves: '',
      skills: '',
      senses: '',
      languages: '',
      traits: [],
      actions: [{ name: 'Grave Bite', text: 'Melee weapon attack: 9 (2d6 + 2) necrotic.' }],
      reactions: [],
      legendary: [],
      extras: {},
    }),
    contentHash: await sha256Hex(text),
  });
  await putChunks([chunk]);
  return chunk.id;
}

/** The owner's row: an authored npc cast out of the library creature. */
async function seedCastRow(campaignId: string): Promise<Artifact> {
  const chunkId = await seedLibraryCreature();
  const cast = await castCreatureAsNpc({
    campaignId,
    moduleId: null,
    citation: { chunkId, creatureName: 'Bog Zombie' },
    name: 'Aunt Agatha',
    prose: { body: 'The risen aunt shambles out of the undercroft.' },
  });
  const artifact = await getArtifact(cast.artifactId);
  if (artifact === undefined) throw new Error('the cast row vanished');
  return artifact;
}

function renderEditor(artifact: Artifact, campaignId: string): void {
  render(
    <ArtifactEditor
      artifact={artifact}
      campaignId={campaignId}
      campaignArtifacts={[artifact]}
      campaignSystem="dnd5e"
    />,
  );
}

describe('a cited row renders its BORROWED numbers', () => {
  it('renders the library creature’s real numbers, labelled as borrowed, with no authored-block affordance', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');
    expect(artifact.data.statBlock).toBeNull();
    expect(artifact.data.creatureRef).toBeDefined();

    renderEditor(artifact, campaign.id);

    const borrowed = await screen.findByTestId('borrowed-stat-block');
    // The VALUES come from the library fixture, not from "something rendered".
    expect(within(borrowed).getByText('AC').parentElement?.textContent).toContain('14');
    expect(within(borrowed).getByText('HP').parentElement?.textContent).toContain('22');
    expect(within(borrowed).getByText('Grave Bite.')).toBeInTheDocument();
    // Borrowed numbers are never mistaken for an authored block: the card is
    // labelled from the library AND carries the disclosed origin label.
    expect(within(borrowed).getByTestId('borrowed-stat-block-badge')).toHaveTextContent(
      'Borrowed from the library',
    );
    expect(within(borrowed).getByTestId('borrowed-stat-block-origin')).toHaveTextContent(
      'NPC: Aunt Agatha (stats from Bestiary p.4)',
    );
    // READ-ONLY: not one control inside the borrowed card.
    expect(within(borrowed).queryAllByRole('button')).toHaveLength(0);

    // The impossible affordance is GONE (the cited-row refill refuses such a
    // block and `npcDataSchema` refuses to keep it).
    expect(screen.queryByRole('button', { name: 'Add stat block' })).toBeNull();

    // And the render WROTE nothing: the row keeps its citation and its null block.
    const stored = await getArtifact(artifact.id);
    if (stored?.kind !== 'npc') throw new Error('not an npc');
    expect(stored.data.statBlock).toBeNull();
    expect(stored.data.creatureRef?.chunkId).toBe(artifact.data.creatureRef?.chunkId);
    await flushAsyncUpdates();
  });

  it('renders the same borrowed numbers on the read-only card (the module reader’s entity panel)', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');

    render(<NpcCard npc={artifact} />);

    const card = await screen.findByTestId('play-npc-card');
    const borrowed = await within(card).findByTestId('borrowed-stat-block');
    expect(within(borrowed).getByText('HP').parentElement?.textContent).toContain('22');
    expect(within(borrowed).getByTestId('borrowed-stat-block-origin')).toHaveTextContent(
      'NPC: Aunt Agatha (stats from Bestiary p.4)',
    );
    await flushAsyncUpdates();
  });
});

describe('a non-cited npc is unchanged', () => {
  it('an AUTHORED block still renders, with its edit and remove controls, and no borrowed card', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      data: {
        appearance: 'Soot-stained.',
        personality: 'Manic.',
        statBlock: {
          ...blankStatBlock('dnd5e'),
          size: 'Small',
          creatureType: 'humanoid (goblinoid)',
          ac: 17,
          hp: 31,
        },
      },
    });

    renderEditor(artifact, campaign.id);

    expect(await screen.findByText('Small humanoid (goblinoid)')).toBeInTheDocument();
    expect(screen.getByText('AC').parentElement?.textContent).toContain('17');
    expect(screen.getByText('HP').parentElement?.textContent).toContain('31');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByTestId('borrowed-stat-block')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add stat block' })).toBeNull();
    await flushAsyncUpdates();
  });

  it('an npc with NO block and NO citation still offers "Add stat block"', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Empty Ernie',
      data: { appearance: '', personality: '', statBlock: null },
    });

    renderEditor(artifact, campaign.id);

    expect(await screen.findByRole('button', { name: 'Add stat block' })).toBeInTheDocument();
    expect(screen.queryByTestId('borrowed-stat-block')).toBeNull();
    await flushAsyncUpdates();
  });
});

describe('an unresolvable library creature is LOUD, never blank', () => {
  it('names the missing creature in place and offers no authored block', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');
    // The library loses the creature the row cites (a re-ingest under a new row
    // id, a removed book): the ONE failure mode, named.
    const chunkId = artifact.data.creatureRef?.chunkId;
    if (chunkId === undefined) throw new Error('the cast row carries no citation');
    await db.chunks.delete(chunkId);

    renderEditor(artifact, campaign.id);

    const missing = await screen.findByTestId('borrowed-stat-block-missing');
    expect(within(missing).getByTestId('borrowed-stat-block-missing-origin')).toHaveTextContent(
      'missing ref (Bog Zombie)',
    );
    expect(missing.textContent).toContain('Aunt Agatha draws its numbers from a library creature');
    // Never a blank/greyish stat area, and never the impossible affordance the
    // cited refill refuses.
    expect(screen.queryByText('AC')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add stat block' })).toBeNull();
    await flushAsyncUpdates();
  });

  it('surfaces a citation that cannot be resolved at all, in place and through the toast seam', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    // A citation carrying NEITHER key is unrepresentable through the cast seam
    // (the library must supply the creature), but a hand-written or repaired
    // row can carry one — and it must never draw an empty stat area.
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Nameless Ghoul',
      data: { appearance: '', personality: '', statBlock: null, creatureRef: {} },
    });

    renderEditor(artifact, campaign.id);

    const failed = await screen.findByTestId('borrowed-stat-block-failed');
    expect(failed.textContent).toContain('carries neither a chunk id nor a content hash');
    await waitFor(() => {
      expect(screen.getByTestId('borrowed-stat-block-failed')).toBeInTheDocument();
    });
    await flushAsyncUpdates();
  });
});

describe('the encounter side reads the SAME numbers (one rule, two readers)', () => {
  it('a roster entry linked to the cast row shows the identical origin label and values', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Aunt Agatha',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: artifact.id },
    });

    // Byte-identical to what the details panel shows — the fold's whole point.
    expect(resolved.origin).toBe('NPC: Aunt Agatha (stats from Bestiary p.4)');
    expect(resolved.statBlock?.hp).toBe(22);
  });

  it('a vanished library creature is named the same way on both readers', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');
    await db.chunks.delete(artifact.data.creatureRef?.chunkId ?? '');

    const resolved = await resolveMonsterEntryWithRepos({
      name: 'Aunt Agatha',
      count: 1,
      notes: '',
      treasure: '',
      source: { type: 'npc-ref', artifactId: artifact.id },
    });

    // The CREATURE is named, not the row: "missing ref (Aunt Agatha)" would
    // only repeat the title the GM is already looking at and would hide which
    // book has to come back.
    expect(resolved).toMatchObject({ statBlock: null, origin: 'missing ref (Bog Zombie)' });
  });
});

describe('the refused pair stays unconstructible', () => {
  it('`npcDataSchema` still refuses a citation beside an authored block, by name', () => {
    const parsed = npcDataSchema.safeParse({
      appearance: '',
      personality: '',
      statBlock: blankStatBlock('dnd5e'),
      creatureRef: { chunkId: '00000000-0000-4000-8000-00000000c001' },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('the refused pair parsed');
    expect(parsed.error.issues[0]?.message).toContain(
      'an npc carries either an authored stat block or a library creatureRef to derive one from, never both',
    );
    // The citation with NO authored block — the shape every cast row has — parses.
    expect(
      npcDataSchema.safeParse({
        appearance: '',
        personality: '',
        statBlock: null,
        creatureRef: { chunkId: '00000000-0000-4000-8000-00000000c001' },
      }).success,
    ).toBe(true);
  });

  it('a cited row whose block is cleared by hand is RE-READ as borrowed, not as an empty block', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const artifact = await seedCastRow(campaign.id);
    if (artifact.kind !== 'npc') throw new Error('not an npc');
    // The editor's autosave path is the only writer here, and it can never set
    // a block on a cited row (the schema would refuse the write); a stray
    // authored value is refused at the repo boundary instead of being kept.
    if (artifact.data.creatureRef === undefined) throw new Error('no citation');
    await expect(
      updateArtifact(artifact.id, {
        data: {
          appearance: '',
          personality: '',
          statBlock: blankStatBlock('dnd5e'),
          creatureRef: artifact.data.creatureRef,
        },
      }),
    ).rejects.toThrow();

    const stored = await getArtifact(artifact.id);
    if (stored?.kind !== 'npc') throw new Error('not an npc');
    expect(stored.data.statBlock).toBeNull();
    expect(stored.data.creatureRef).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// tests/features/export-dialog.test.tsx
//
// NOTE ON ADJACENCY: this describe is deliberately placed BETWEEN other
// describes. Its tests mutate process-wide globals (`URL.createObjectURL`,
// `HTMLAnchorElement.prototype.click`) that `vi.restoreAllMocks()` does NOT
// undo (they are direct assignments/defineProperty, not spies). Placing it
// mid-file proves the neighbours tolerate that leak rather than hiding it at
// the tail.
// ---------------------------------------------------------------------------

/**
 * Export dialog (08-TESTING matrix gap): the campaign card's ⋮ menu opens the
 * campaign-wide export dialog (M2: artifact selection + JSON/zip formats).
 * Downloads are captured at the blob-URL seam and decoded to verify the
 * payload. Import is exercised in lib/exportImport tests.
 */

function renderPicker(): void {
  render(
    <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
      <Routes>
        <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ExportCampaignDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports the selected artifacts as JSON through the download seam', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });
    await createArtifact({ campaignId: campaign.id, kind: 'location', name: 'Forge' });

    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:mock-export';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const clickSpy = vi.fn();
    HTMLAnchorElement.prototype.click = clickSpy;

    renderPicker();
    await screen.findByText('Emberfall');

    // The card menu opens the dialog (regression: the dialog was mounted but
    // unreachable — the menu downloaded JSON directly instead).
    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Export “Emberfall”/)).toBeInTheDocument();
    expect(within(dialog).getByText('Grix')).toBeInTheDocument();
    expect(within(dialog).getByText('Forge')).toBeInTheDocument();

    // Deselect one artifact → export the remaining one.
    const forgeRow = within(dialog).getByText('Forge').closest('label');
    if (forgeRow === null) throw new Error('Forge row not found');
    await user.click(within(forgeRow).getByRole('checkbox'));
    expect(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' })).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' }));

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalled();
    });
    expect(blobs).toHaveLength(1);
    const blob = blobs[0];
    if (blob === undefined) throw new Error('no export blob captured');
    const exported = JSON.parse(await blob.text()) as {
      campaign: { name: string };
      artifacts: { name: string }[];
    };
    expect(exported.campaign.name).toBe('Emberfall');
    expect(exported.artifacts.map((artifact) => artifact.name)).toEqual(['Grix']);
    await flushAsyncUpdates();
  }, 20000);

  it('select-all off disables the export; zip format produces a zip blob', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });

    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:mock-export';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    HTMLAnchorElement.prototype.click = vi.fn();

    renderPicker();
    await screen.findByText('Emberfall');
    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));

    const dialog = await screen.findByRole('dialog');

    // Unchecking "all artifacts" leaves nothing selected → export disabled.
    const selectAll = within(dialog).getByRole('checkbox', { name: 'All artifacts (1)' });
    await user.click(selectAll);
    expect(within(dialog).getByRole('button', { name: /Export 0 artifact\(s\)/ })).toBeDisabled();

    // Re-select, switch to zip, export: the blob is a real zip (PK magic).
    await user.click(selectAll);
    await user.click(within(dialog).getByRole('button', { name: 'Zip bundle' }));
    await user.click(within(dialog).getByRole('button', { name: 'Export 1 artifact(s)' }));

    await waitFor(() => {
      expect(blobs).toHaveLength(1);
    });
    const blob = blobs[0];
    if (blob === undefined) throw new Error('no zip blob captured');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    await flushAsyncUpdates();
  }, 20000);

  it('cancel closes the dialog without downloading', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });

    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:mock-export';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    renderPicker();
    await screen.findByText('Emberfall');
    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(blobs).toHaveLength(0);
    await flushAsyncUpdates();
  }, 20000);

  it('exports every artifact by default when nothing is deselected', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Grix' });
    await createArtifact({ campaignId: campaign.id, kind: 'location', name: 'Forge' });

    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:mock-export';
      }),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    HTMLAnchorElement.prototype.click = vi.fn();

    renderPicker();
    await screen.findByText('Emberfall');
    await user.click(screen.getByRole('button', { name: 'Menu for Emberfall' }));
    await user.click(await screen.findByRole('menuitem', { name: /Export campaign/ }));

    const dialog = await screen.findByRole('dialog');
    // All artifacts are preselected: the button offers the full count.
    const exportButton = within(dialog).getByRole('button', { name: 'Export 2 artifact(s)' });
    expect(exportButton).toBeEnabled();
    await user.click(exportButton);

    await waitFor(() => {
      expect(blobs).toHaveLength(1);
    });
    const blob = blobs[0];
    if (blob === undefined) throw new Error('no export blob captured');
    const exported = JSON.parse(await blob.text()) as {
      artifacts: { name: string; revisions: unknown[] }[];
    };
    expect(exported.artifacts.map((artifact) => artifact.name).sort()).toEqual([
      'Forge',
      'Grix',
    ]);
    // Each artifact carries its revision history (createArtifact writes rev 1).
    expect(exported.artifacts.every((artifact) => artifact.revisions.length >= 1)).toBe(true);
    await flushAsyncUpdates();
  }, 20000);
});

// ---------------------------------------------------------------------------
// tests/features/tree-scope.test.tsx
// ---------------------------------------------------------------------------

/**
 * Scope control in the workspace tree (10-MILESTONE-6 C, D3/D4): module-owned
 * rows group under their module, the global library renders in its own
 * "Library" group (hidden by default in the workspace), publishing a
 * library-kind artifact is a loud two-step act, and the adopt flow returns a
 * library row to a campaign.
 */

async function openRowMenu(user: UserEvent, artifactName: string): Promise<void> {
  await user.pointer([
    { keys: '[MouseRight>]', target: screen.getByText(artifactName) },
    { keys: '[/MouseRight]' },
  ]);
  await screen.findByRole('menu');
}

describe('workspace tree scope control', () => {
  let campaignId = '';
  let moduleId = '';

  beforeEach(async () => {
    // `clearDatabase()` is the merged file's shared top-level beforeEach.
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    campaignId = campaign.id;
    const module = await saveModule(
      createModuleRow({
        campaignId,
        title: 'Ember Crypt',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'sketch',
      }),
    );
    moduleId = module.id;
    await createArtifact({ campaignId, moduleId, kind: 'npc', name: 'Kael' });
    await createArtifact({ campaignId, kind: 'npc', name: 'Mira' });
  });

  it('groups module-owned rows under their module; plain rows stay in kind groups', async () => {
    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Kael');
    await flushAsyncUpdates();

    expect(screen.getByText('Ember Crypt')).toBeInTheDocument();
    // The module group carries its own row; the kind group does not list it.
    const miraList = screen.getByText('Mira').closest('ul') as HTMLElement;
    expect(within(miraList).queryByText('Kael')).toBeNull();
    await flushAsyncUpdates();
  });

  it('renders a row whose module row is gone as an explicit orphaned group with a re-anchor action', async () => {
    const user = userEvent.setup();
    // A module-owned row whose module row is missing (a pre-integrity-fix
    // dangling write or external tampering): the tree must NOT silently
    // blend it into the kind groups — it shows an explicit "Orphaned" group.
    const deadModuleId = '00000000-0000-4000-8000-0000000000de';
    const orphan = await createArtifact({
      campaignId,
      moduleId: deadModuleId,
      kind: 'npc',
      name: 'Ghost Orphan',
    });
    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Ghost Orphan');
    await flushAsyncUpdates();

    expect(screen.getByText('Orphaned')).toBeInTheDocument();
    // The orphan lives in the orphan group — never inside the kind groups.
    const miraList = screen.getByText('Mira').closest('ul') as HTMLElement;
    expect(within(miraList).queryByText('Ghost Orphan')).toBeNull();
    const orphanList = screen.getByText('Ghost Orphan').closest('ul') as HTMLElement;
    expect(within(orphanList).queryByText('Mira')).toBeNull();
    expect(within(orphanList).getAllByText('Ghost Orphan')).toHaveLength(1);

    // One-click honesty: re-anchor moves the row back into campaign
    // ownership (the sanctioned moveScope pathway) — no silent blending.
    await openRowMenu(user, 'Ghost Orphan');
    await user.click(await screen.findByTestId('tree-reanchor'));
    await waitFor(async () => {
      const row = await getAnyArtifact(orphan.id);
      expect(row?.moduleId).toBeNull();
      expect(row?.campaignId).toBe(campaignId);
    });
    await flushAsyncUpdates();
  }, 20000);

  it('publishes a library-kind artifact via the loud confirm; notes are not publishable', async () => {
    const user = userEvent.setup();
    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Kael');

    await flushAsyncUpdates();
    await openRowMenu(user, 'Kael');
    await user.click(await screen.findByRole('menuitem', { name: 'Publish to library…' }));
    const dialog = await screen.findByTestId('publish-dialog');
    expect(dialog).toHaveTextContent(/visible and editable from every campaign/);
    await user.click(within(dialog).getByTestId('publish-confirm'));

    let publishedId = '';
    await waitFor(async () => {
      const globals = await listGlobalArtifacts();
      expect(globals).toHaveLength(1);
      publishedId = globals[0]?.id ?? '';
      expect(globals[0]?.campaignId).toBeNull();
      expect(await getArtifact(publishedId)).toBeUndefined();
    });

    // Library group hidden by default in the workspace (D3)… (the scope
    // toggle itself is also labeled "Library" — target the group header.)
    await waitFor(async () => {
      const scopes = (await readSettings()).artifactScopes.workspace;
      expect(scopes.global).toBe(false);
    });
    expect(screen.queryByRole('button', { name: /Library/ })).not.toBeInTheDocument();

    // …and shown once the user turns the toggle on.
    await user.click(screen.getByTestId('scope-toggle-global'));
    await screen.findByRole('button', { name: /Library/ });
    await flushAsyncUpdates();
  }, 20000);

  it('does not offer publishing for non-library kinds', async () => {
    const user = userEvent.setup();
    await createArtifact({ campaignId, kind: 'note', name: 'Journal' });
    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Journal');

    await flushAsyncUpdates();
    await openRowMenu(user, 'Journal');
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Publish to library…' })).toBeNull();
    await user.keyboard('{Escape}');
    await flushAsyncUpdates();
  });

  it('adopts a library row back into the campaign', async () => {
    const user = userEvent.setup();
    const globalId = '00000000-0000-4000-8000-0000000000a99';
    const row = await createArtifact({ campaignId, kind: 'faction', name: 'The Salt Guild' });
    await updateSettings({
      artifactScopes: {
        workspace: { global: true, campaign: true, module: true },
        moduleView: { global: true, campaign: true, module: true },
      },
    });
    // Publish, then re-open the workspace so the tree lists it as a library row.
    const { publishToLibrary } = await import('@/db/artifactRepo');
    await publishToLibrary(row.id);
    expect((await getAnyArtifact(globalId)) === undefined).toBe(true);
    expect((await listGlobalArtifacts()).map((entry) => entry.name)).toContain('The Salt Guild');

    renderWorkspace(workspacePath(campaignId));
    await screen.findByText('Library');
    await flushAsyncUpdates();

    await openRowMenu(user, 'The Salt Guild');
    await user.click(await screen.findByRole('menuitem', { name: 'Adopt into campaign…' }));
    const dialog = await screen.findByTestId('adopt-dialog');
    await user.click(within(dialog).getByTestId(`adopt-into-${campaignId}`));
    await flushAsyncUpdates();

    await waitFor(async () => {
      const adopted = await getArtifact(row.id);
      expect(adopted?.campaignId).toBe(campaignId);
    });
    expect((await listGlobalArtifacts()).length).toBe(0);
    await flushAsyncUpdates();
    await flushAsyncUpdates();
  });

  it('persists scope toggles per surface in settings', async () => {
    // Rendered standalone: the full workspace page mounts several live-query
    // panes whose settle chain would drown this small assertion in act()
    // noise — the toggle's persistence is what matters here.
    render(<ScopeControl surface="workspace" />);
    const user = userEvent.setup();
    await flushAsyncUpdates();

    expect((await readSettings()).artifactScopes.workspace.global).toBe(false);
    await user.click(screen.getByTestId('scope-toggle-global'));
    await flushAsyncUpdates(40);
    const after = await readSettings();
    expect(after.artifactScopes.workspace.global).toBe(true);
    // The module view keeps its own preference (D4 — independent surfaces).
    expect(after.artifactScopes.moduleView.global).toBe(true);
    await flushAsyncUpdates();
  });
});

// ---------------------------------------------------------------------------
// tests/features/workspace.test.tsx
// ---------------------------------------------------------------------------

describe('WorkspacePage', () => {
  it('renders the tree and opens the editor when an artifact row is clicked', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Gorim',
      body: 'A dwarf smith.',
    });

    renderWorkspace(workspacePath(campaign.id));

    expect(await screen.findByText('Gorim')).toBeDefined();
    expect(screen.getByTestId('persona-panel')).toBeDefined();

    await user.click(screen.getByText('Gorim'));

    expect(await screen.findByTestId('artifact-editor')).toBeDefined();
    expect(screen.getByTestId('revision-badge').textContent).toBe('rev 1');
  });

  it('links module-owned artifacts back to their module reader ("Open in module")', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await saveModule(
      createModuleRow({
        campaignId: campaign.id,
        title: 'The Drowned Vault',
        concept: 'A flooded vault beneath a watchtower.',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
      }),
    );
    const kael = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Kael',
      body: 'The gate warden.',
    });

    window.history.replaceState(null, '', artifactPath(campaign.id, kael.id));
    render(<RouterProvider router={createAppRouter()} />);

    expect(await screen.findByTestId('artifact-editor', {}, { timeout: 10_000 })).toBeDefined();
    const link = screen.getByTestId('open-in-module');
    expect(link).toHaveAttribute('href', modulePath(campaign.id, module.id));
    // The tooltip names the module once its live query resolves.
    await waitFor(() => {
      expect(link).toHaveAttribute('title', 'Open "The Drowned Vault" in the module reader');
    });
  });

  it('creates an artifact via the tree + button with a non-empty default name', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

    renderWorkspace(workspacePath(campaign.id));

    await user.click(await screen.findByRole('button', { name: 'New NPC' }));

    expect(await screen.findByTestId('artifact-editor')).toBeDefined();
    const nameInput = screen.getByTestId<HTMLInputElement>('artifact-name');
    expect(nameInput.value).toBe('New NPC');
    await waitFor(async () => {
      const stored = await db.artifacts.where('campaignId').equals(campaign.id).toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.name).toBe('New NPC');
    });
  });

  it('shows the welcome panel when no artifact is open', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

    renderWorkspace(workspacePath(campaign.id));

    expect(await screen.findByText('Welcome to Ember')).toBeDefined();
    expect(screen.queryByTestId('artifact-editor')).toBeNull();
  });

  it('deletes an artifact from the visible row button, clearing dangling links', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const npc = await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Gorim' });
    await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Forge',
      links: [{ targetId: npc.id, relation: 'workplace-of' }],
    });

    renderWorkspace(workspacePath(campaign.id));
    expect(await screen.findByText('Gorim')).toBeDefined();

    // Hover-revealed trash button on the row (always in the a11y tree).
    await user.click(screen.getByRole('button', { name: 'Delete Gorim' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.queryByText('Gorim')).not.toBeInTheDocument();
    });
    // Drain the delete-triggered live-query updates before the plain DB reads.
    await flushAsyncUpdates();
    const { getArtifact } = await import('@/db/artifactRepo');
    const rows = await import('@/db/artifactRepo').then((m) =>
      m.listArtifactsByCampaign(campaign.id),
    );
    expect(await getArtifact(npc.id)).toBeUndefined();
    expect(rows.find((row) => row.name === 'Forge')?.links).toEqual([]);
    await flushAsyncUpdates();
  }, 20000);

  it('shows persona names, not ids, in selects after choosing', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await seedBuiltInPersonas();

    renderWorkspace(workspacePath(campaign.id));

    // Wait for the personas live query to resolve (the Assistant tab's
    // persona select shows the placeholder until then).
    const personaTrigger = await screen.findByRole('combobox', { name: 'Persona' });
    await waitFor(() => {
      expect(personaTrigger.textContent).not.toBe('Loading…');
    });

    // The chain builder pre-selects the first persona: the closed trigger
    // must show its human-readable NAME, never the raw id (regression for
    // selects displaying uuids after a choice).
    await user.click(screen.getByRole('tab', { name: "Writers' room" }));
    await screen.findByTestId('writers-room');
    await user.click(screen.getByRole('button', { name: 'Add step' }));
    const stepTrigger = await screen.findByRole('combobox', { name: 'Step 1 persona' });
    const { listPersonas } = await import('@/db/personaRepo');
    const personas = await listPersonas();
    const firstPersona = personas[0];
    expect(firstPersona).toBeDefined();
    await waitFor(() => {
      expect(stepTrigger.textContent).toBe(`${firstPersona?.name}▼`);
    });
    expect(stepTrigger.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  }, 20000);

  it('deletes a run from the Runs tab', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const { createRun } = await import('@/db/runRepo');
    const run = await createRun({
      campaignId: campaign.id,
      personaId: newId(),
      autonomy: 'manual',
      userBrief: 'a unique brief for deletion',
      pinnedChunkIds: [],
    });

    renderWorkspace(workspacePath(campaign.id));
    await user.click(await screen.findByRole('tab', { name: 'Runs' }));
    expect(await screen.findByText('a unique brief for deletion')).toBeDefined();

    await user.click(
      screen.getByRole('button', {
        name: `Delete run ${new Date(run.updatedAt).toLocaleString()}`,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText('a unique brief for deletion')).not.toBeInTheDocument();
    });
    const { getRun } = await import('@/db/runRepo');
    expect(await getRun(run.id)).toBeUndefined();
  }, 20000);
});
