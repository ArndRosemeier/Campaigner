import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTES, workspacePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { artifactRevisionSchema, stampNewEntity, type AnyArtifact } from '@/domain';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspacePage } from '@/features/campaign/WorkspacePage';
import { RevisionDialog } from '@/features/campaign/components/revision-dialog';
import { CollapsibleRow, EncounterCard, NpcCard } from '@/features/play/artifact-cards';
import { PeekModal } from '@/features/modules/peek-modal';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * MODEL-PROSE RENDERING (docs/17 row 217): every model-authored prose field the
 * owner reported as showing raw `[[Name]]` bytes renders through the ONE
 * wiki-aware renderer `WikiMarkdown`.
 *
 * These are BEHAVIOUR pins on the migrated surfaces, driven with small direct
 * fixtures rather than a second copy of each surface's full page harness: a
 * resolved token is a kind-coloured chip that opens the artifact, an unresolved
 * one is the dashed chip whose `title` carries the byte-exact token — and the
 * literal `[[`/`]]` bytes never appear in the rendered TEXT. The battle board's
 * copy lives in `battle-surface.test.tsx` (its own seeded harness) and the
 * module reader's in `reader-encounter-roster.test.tsx`.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

const RESOLVED = 'Ash Gate';
const UNRESOLVED = 'Ghost Keep';

/** The artifact kinds a pool must hold for a token to resolve. */
async function seedPool(campaignId: string): Promise<AnyArtifact> {
  return createArtifact({
    campaignId,
    kind: 'location',
    name: RESOLVED,
    summary: 'A sealed gate.',
  });
}

function tokenText(el: HTMLElement): string {
  return el.textContent;
}

beforeEach(clearDatabase);
afterEach(cleanup);

describe('a model-prose field renders through the ONE wiki renderer', () => {
  it('NpcCard: a resolved token is a chip that opens the artifact, an unresolved one is dashed, and no raw bytes survive', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const gate = await seedPool(campaign.id);
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Silt Warden',
      summary: `Collects the toll at [[${RESOLVED}]].`,
    });
    if (npc.kind !== 'npc') throw new Error('npc artifact expected');

    const opened: AnyArtifact[] = [];
    render(
      <NpcCard
        npc={npc}
        artifacts={[gate, npc]}
        onOpenArtifact={(artifact) => {
          opened.push(artifact);
        }}
      />,
    );

    const card = screen.getByTestId('play-npc-card');
    // The resolved chip carries the artifact id and opens that artifact.
    const resolvedChip = within(card).getByTestId('wiki-chip');
    expect(resolvedChip.getAttribute('data-wiki-artifact-id')).toBe(gate.id);
    await userEvent.setup().click(resolvedChip);
    expect(opened.map((artifact) => artifact.id)).toEqual([gate.id]);
    // The raw token never reaches the rendered text.
    expect(tokenText(card)).not.toContain('[[');
    expect(tokenText(card)).not.toContain(']]');
  }, 20_000);

  it('NpcCard: appearance resolves or dashes per token, personality without a token is unchanged', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const gate = await seedPool(campaign.id);
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Silt Warden',
      summary: 'Collects the toll.',
      data: { appearance: `A voice from [[${UNRESOLVED}]].`, personality: 'Quiet and exact.', statBlock: null },
    });
    if (npc.kind !== 'npc') throw new Error('npc artifact expected');

    render(<NpcCard npc={npc} artifacts={[gate, npc]} />);
    const card = screen.getByTestId('play-npc-card');

    // The unresolved token keeps its name visible in the dashed chip…
    const dashed = within(card).getByTestId('wiki-chip-unresolved');
    expect(dashed.textContent).toContain(UNRESOLVED);
    // …and the byte-exact token survives only in the chip's tooltip, never in
    // the rendered text.
    expect(dashed.getAttribute('title')).toContain(`[[${UNRESOLVED}]]`);
    expect(tokenText(card)).not.toContain('[[');
    // A field with no token reads exactly as before.
    expect(within(card).getByText('Quiet and exact.')).toBeInTheDocument();
    expect(within(card).getByText('Collects the toll.')).toBeInTheDocument();
  }, 20_000);

  it('EncounterCard: the summary AND a roster entry’s notes both chip, and open the same pool', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const gate = await seedPool(campaign.id);
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Ford Ambush',
      summary: `They spring it at [[${RESOLVED}]].`,
      data: {
        difficulty: 'hard',
        levelHint: '', partyLevel: 4,
        monsters: [
          {
            name: 'Cultist',
            count: 1,
            notes: `Sworn to [[${RESOLVED}]]; a rumor names [[${UNRESOLVED}]].`,
            treasure: '',
            source: { type: 'none' as const },
          },
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
    if (encounter.kind !== 'encounter') throw new Error('encounter artifact expected');

    const opened: AnyArtifact[] = [];
    render(
      <EncounterCard
        encounter={encounter}
        artifacts={[gate, encounter]}
        onOpenArtifact={(artifact) => {
          opened.push(artifact);
        }}
      />,
    );

    const card = screen.getByTestId('play-encounter-card');
    const panel = await within(card).findByTestId('stat-blocks-panel', {}, { timeout: 10_000 });
    await waitFor(
      () => {
        expect(within(panel).getAllByTestId('roster-entry').length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    const row = within(panel).getAllByTestId('roster-entry')[0];
    if (row === undefined) throw new Error('roster entry missing');

    // The summary's resolved chip (outside the roster panel)…
    const summaryChip = within(card)
      .getAllByTestId('wiki-chip')
      .find((chip) => !panel.contains(chip));
    if (summaryChip === undefined) throw new Error('summary chip missing');
    expect(summaryChip.getAttribute('data-wiki-artifact-id')).toBe(gate.id);
    // …the notes' resolved chip and its dashed sibling, all in the SAME pool.
    const noteChip = within(row).getAllByTestId('wiki-chip')[0];
    const dashed = within(row).getByTestId('wiki-chip-unresolved');
    if (noteChip === undefined) throw new Error('notes chip missing');
    expect(noteChip.getAttribute('data-wiki-artifact-id')).toBe(gate.id);
    expect(dashed.textContent).toContain(UNRESOLVED);
    await userEvent.setup().click(noteChip);
    expect(opened.map((artifact) => artifact.id)).toEqual([gate.id]);
    expect(tokenText(card)).not.toContain('[[');
    await flushAsyncUpdates();
  }, 20_000);

  it('CollapsibleRow: the expanded summary chips even with no context (empty pool dashes, never raw bytes)', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const artifact = await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Loose Note',
      summary: `Refers to [[${UNRESOLVED}]].`,
    });

    render(<CollapsibleRow artifact={artifact} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Expand Loose Note' }));

    const dashed = screen.getByTestId('wiki-chip-unresolved');
    expect(dashed.textContent).toContain(UNRESOLVED);
    expect(document.body.textContent).not.toContain('[[');
    expect(document.body.textContent).not.toContain(`[[${UNRESOLVED}]]`);
  }, 20_000);

  it('RevisionDialog: both snapshot fields render through the seam (empty pool), never through a second markdown import', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const snapshot = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'The Vault',
      summary: `Guarded by [[${UNRESOLVED}]].`,
      body: `Inside, a second door names [[${UNRESOLVED}]].`,
    });
    const revision = artifactRevisionSchema.parse({
      ...stampNewEntity(),
      artifactId: snapshot.id,
      revision: 1,
      snapshot,
      source: 'user',
    });

    render(<RevisionDialog revision={revision} onOpenChange={vi.fn()} onRestore={vi.fn()} />);
    await flushAsyncUpdates();

    const dialog = await screen.findByRole('dialog');
    // BOTH fields resolve to nothing (no pool here) but still render the
    // dashed chip: the raw `[[…]]` bytes are nowhere in the text.
    expect(within(dialog).getAllByTestId('wiki-chip-unresolved')).toHaveLength(2);
    expect(tokenText(dialog)).not.toContain('[[');
    // The raw token survives only in each chip's byte-exact tooltip.
    for (const chip of within(dialog).getAllByTestId('wiki-chip-unresolved')) {
      expect(chip.getAttribute('title')).toContain(`[[${UNRESOLVED}]]`);
    }
    await flushAsyncUpdates();
  }, 20_000);
});

/**
 * THE INTEGRATION PIN (docs/17 row 219): the component pins above render
 * `NpcCard`/`EncounterCard` DIRECTLY and hand each one its own pool, so they
 * cannot see whether the PEEK MODAL — the module reader's entity card, the very
 * screen the owner reported — threads its own pool and breadcrumb push down. The
 * dispatcher's arm D (`artifacts={artifacts}` → `artifacts={[]}` inside
 * `peek-modal.tsx`) left every component-level pin GREEN, which is the measured
 * gap this block closes: the card is mounted by the MODAL here, with the modal's
 * own pool, and opening a resolved chip must run the MODAL's breadcrumb push.
 */
describe('the peek modal (the module reader’s entity card) threads its own pool and breadcrumb push', () => {
  it('NpcCard: the modal’s pool resolves the npc summary token, and the click pushes the linked artifact onto the modal’s own breadcrumb', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const gate = await seedPool(campaign.id);
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Silt Warden',
      summary: `Collects the toll at [[${RESOLVED}]].`,
    });
    if (npc.kind !== 'npc') throw new Error('npc artifact expected');

    render(
      <MemoryRouter>
        <PeekModal
          artifact={npc}
          artifacts={[gate, npc]}
          open
          onOpenChange={vi.fn()}
          campaignId={campaign.id}
        />
      </MemoryRouter>,
    );

    const peek = await screen.findByTestId('peek-modal');
    const card = within(peek).getByTestId('play-npc-card');
    // The modal handed its OWN pool down: the chip is RESOLVED against the pool
    // row (not the dashed unresolved chip an empty pool would produce).
    const chip = within(card).getByTestId('wiki-chip');
    expect(chip.getAttribute('data-wiki-artifact-id')).toBe(gate.id);
    expect(within(peek).queryByTestId('wiki-chip-unresolved')).not.toBeInTheDocument();

    // The click runs the MODAL's breadcrumb push (there is no caller callback on
    // this mount): the title becomes the linked artifact and Back appears, i.e.
    // the stack really moved to the pool row the chip named.
    await userEvent.setup().click(chip);
    await waitFor(() => {
      expect(peek.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(RESOLVED);
    });
    expect(within(peek).getByTestId('peek-back')).toBeInTheDocument();
    expect(within(peek).queryByTestId('play-npc-card')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);

  it('EncounterCard: the modal’s pool resolves the encounter summary token, and the click pushes the linked artifact onto the modal’s own breadcrumb', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const gate = await seedPool(campaign.id);
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Ford Ambush',
      summary: `They spring it at [[${RESOLVED}]].`,
      data: {
        difficulty: 'hard',
        levelHint: '', partyLevel: 4,
        monsters: [],
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
    if (encounter.kind !== 'encounter') throw new Error('encounter artifact expected');

    render(
      <MemoryRouter>
        <PeekModal
          artifact={encounter}
          artifacts={[gate, encounter]}
          open
          onOpenChange={vi.fn()}
          campaignId={campaign.id}
        />
      </MemoryRouter>,
    );

    const peek = await screen.findByTestId('peek-modal');
    const card = within(peek).getByTestId('play-encounter-card');
    const chip = within(card).getByTestId('wiki-chip');
    expect(chip.getAttribute('data-wiki-artifact-id')).toBe(gate.id);
    expect(within(peek).queryByTestId('wiki-chip-unresolved')).not.toBeInTheDocument();

    await userEvent.setup().click(chip);
    await waitFor(() => {
      expect(peek.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(RESOLVED);
    });
    expect(within(peek).getByTestId('peek-back')).toBeInTheDocument();
    expect(within(peek).queryByTestId('play-encounter-card')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);
});

describe('the campaign-tree summary tooltip resolves against the tree’s own pool', () => {
  it('renders a resolved token as a chip in the row tooltip', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const gate = await seedPool(campaign.id);
    await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Old Tower',
      summary: `Reached through [[${RESOLVED}]].`,
    });
    const user = userEvent.setup();

    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={[workspacePath(campaign.id)]}>
          <Routes>
            <Route path={ROUTES.workspace} element={<WorkspacePage />} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>,
    );

    const row = await screen.findByText('Old Tower');
    await user.hover(row);
    const chip = await screen.findByTestId('wiki-chip', {}, { timeout: 5_000 });
    expect(chip.getAttribute('data-wiki-artifact-id')).toBe(gate.id);
    expect(document.body.textContent).not.toContain('[[');
  }, 20_000);
});
