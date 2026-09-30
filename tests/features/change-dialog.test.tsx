import { actDrained } from '../helpers/flush';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifact,
  createCampaign,
  type AnyArtifact,
  type Campaign,
  type Module,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { moduleDocumentFixture } from '../helpers/moduleDocumentFixture';
import { ChangeDialog } from '@/features/modules/change-dialog';
import {
  selectGenerationTargets,
  type GenerationChangeScope,
} from '@/features/modules/generation-selection';
import type {
  GenerationRunInput,
  GenerationRunReport,
} from '@/features/modules/generation-run';
import type * as generationRunModule from '@/features/modules/generation-run';
import { adoptionArenaLayout } from '../helpers/battle-map-fixtures';

/**
 * THE CHANGE DIALOG (docs/17 row 431, owner-directed) — the SIBLING of the
 * generation dialog, and the ONE surface that redoes work that already exists.
 *
 * The owner's report this file pins, verbatim: *"The generate dialog can
 * overwrite. But if i just want to overwrite all the images i can not do that,
 * button is grey until i select a kind. Which would be wrong since i only want to
 * redo images."* and then the decision: *"Lets do a sibling dialog just for
 * changes. Keep all the change work out of the generation dialog and leave it to
 * do just that, generate things that are not there."*
 *
 * So the pins are:
 * 1. EVERY kind carries Texts and Images, and the encounter row carries the two
 *    standard extras — the owner's own shape for this dialog;
 * 2. NOTHING TICKED is the only reason the button is disabled: a single tick of
 *    Images for every kind is a complete, countable run with no generation kind
 *    involved at all (the case that used to answer "Nothing selected — tick a
 *    kind or widen the level range.");
 * 3. the run is dispatched with an EMPTY generation half — this dialog creates
 *    nothing, it only replaces;
 * 4. replacing asks ONE confirmation first, and nothing runs until it is
 *    confirmed.
 */

const runGenerationSelection = vi.fn<
  (input: GenerationRunInput) => Promise<GenerationRunReport>
>(() => {
  throw new Error('the run must not be called by this arm');
});

vi.mock('@/features/modules/generation-run', async (importOriginal) => ({
  // The dock-entry id and the ONE run-active hook are the REAL ones (docs/17 row
  // 419): the dialog reads the progress store through them, and BOTH dialogs
  // share the hook since docs/17 row 431.
  generationRunJobId: (await importOriginal<typeof generationRunModule>())
    .generationRunJobId,
  useGenerationRunActive: (await importOriginal<typeof generationRunModule>())
    .useGenerationRunActive,
  runGenerationSelection: (input: GenerationRunInput) => runGenerationSelection(input),
}));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

const CAMPAIGN: Campaign = createCampaign({ name: 'The Harbor', system: 'dnd5e' });
const COVER = '00000000-0000-4000-8000-00000000c0de';
const MAP = '00000000-0000-4000-8000-0000000000aa';

const SECTIONS = [
  '[[Kael]] meets [[Mira]] at the [[Ash Gate]] and [[Ash Fight]] begins.',
  '[[Kael]] travels to [[Old Keep]].',
  'Nothing new here but [[High Hall]].',
];

const ENTITY_KINDS = [
  { name: 'Ash Gate', kind: 'location' as const },
  { name: 'Kael', kind: 'npc' as const },
  { name: 'Mira', kind: 'npc' as const },
  { name: 'Ash Fight', kind: 'encounter' as const },
  { name: 'Old Keep', kind: 'location' as const },
  { name: 'High Hall', kind: 'location' as const },
].map((entry) => ({
  ...entry,
  absorbed: [],
  ...(entry.kind === 'npc' || entry.kind === 'encounter' ? { levelHint: 3 } : {}),
}));

const CHANGE_MODULE_OPTIONS = {
  campaignId: CAMPAIGN.id,
  entityKinds: ENTITY_KINDS,
  premise: 'The harbor hides the [[Drowned Gate]].',
  sections: SECTIONS,
};

function moduleFixture(): Module {
  return moduleDocumentFixture(CHANGE_MODULE_OPTIONS);
}

/** Everything the dialog can redo: a written NPC + location (with covers), a
 *  mapped + rostered encounter, and one row this module does NOT own. */
function world(module: Module): AnyArtifact[] {
  const own = (kind: 'npc' | 'location', name: string, cover: boolean): AnyArtifact =>
    createArtifact({
      campaignId: CAMPAIGN.id,
      moduleId: module.id,
      kind,
      name,
      summary: 'Written by the old model.',
      body: '',
      ...(cover ? { coverImageId: COVER, imageIds: [COVER] } : {}),
    });
  const blank = createArtifact({
    campaignId: CAMPAIGN.id,
    moduleId: module.id,
    kind: 'encounter',
    name: 'Ash Fight',
    summary: 'Goblins at the gate.',
    body: '',
  });
  if (blank.kind !== 'encounter') throw new Error('fixture: not an encounter');
  const encounter: AnyArtifact = {
    ...blank,
    imageIds: [MAP],
    data: {
      ...blank.data,
      layout: adoptionArenaLayout('4:3'),
      mapImageId: MAP,
      monsters: [{ name: 'Goblin', count: 2, notes: '', treasure: '', source: { type: 'none' } }],
    },
  };
  return [
    own('npc', 'Kael', true),
    own('location', 'Ash Gate', false),
    // Mira resolves, but to a CAMPAIGN-level row this module does not own.
    createArtifact({
      campaignId: CAMPAIGN.id,
      kind: 'npc',
      name: 'Mira',
      summary: 'Written elsewhere.',
      body: '',
    }),
    encounter,
  ];
}

function renderDialog(module: Module, artifacts: readonly AnyArtifact[]) {
  const onOpenChange = vi.fn();
  render(
    <ChangeDialog
      module={module}
      campaign={CAMPAIGN}
      artifacts={artifacts}
      open
      onOpenChange={onOpenChange}
      blockedReason={null}
    />,
  );
  return { onOpenChange };
}

/** A run report whose selection is the seam's own answer for the same ask. */
function report(
  module: Module,
  artifacts: readonly AnyArtifact[],
  change: GenerationChangeScope,
  overrides: Partial<GenerationRunReport> = {},
): GenerationRunReport {
  return {
    selection: selectGenerationTargets({
      module,
      artifacts,
      kinds: [],
      imageKinds: [],
      levelRange: { min: 0, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
      change,
    }),
    generated: 0,
    regenerated: 0,
    imageJobs: 0,
    mapJobs: 0,
    portraitJobs: 0,
    refused: null,
    classified: [],
    stopped: false,
    notes: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await clearDatabase();
  runGenerationSelection.mockReset();
});

describe('the Change dialog is its own scope (docs/17 row 431)', () => {
  it('offers Texts and Images for EVERY kind, and the encounter extras on the encounter row only', () => {
    const module = moduleFixture();
    renderDialog(module, world(module));

    for (const kind of ['npc', 'location', 'event', 'faction', 'note', 'encounter']) {
      expect(screen.getByTestId(`change-texts-${kind}`)).toBeDefined();
      expect(screen.getByTestId(`change-images-${kind}`)).toBeDefined();
    }
    // The two "standard extras for encounters" (the owner's words) exist once…
    expect(screen.getByTestId('change-battlemaps')).toBeDefined();
    expect(screen.getByTestId('change-mob-portraits')).toBeDefined();
    // …and nothing else in the dialog reuses those ids.
    expect(screen.queryByTestId('change-texts-encounter-extra')).toBeNull();
  });

  it('nothing ticked: the button is disabled and the box says there is nothing to change', () => {
    const module = moduleFixture();
    renderDialog(module, world(module));

    expect(screen.getByTestId('change-scope-count').textContent).toBe(
      'Nothing to change — nothing you ticked exists yet.',
    );
    expect(screen.getByTestId('change-run')).toBeDisabled();
  });

  it('IMAGES for every kind, nothing else: the button is ENABLED and no text is touched (the owner’s report)', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    renderDialog(module, world(module));

    // The owner's exact ask: redo the images, nothing else. No "generation kind"
    // exists in this dialog at all — that is the point of the sibling.
    for (const kind of ['npc', 'location', 'event', 'faction', 'note', 'encounter']) {
      await user.click(screen.getByTestId(`change-images-${kind}`));
    }

    // Kael carries a cover; Ash Gate does not; the encounter's only image is its
    // battlemap, so no cover either. ONE image job — and never a grey button.
    expect(screen.getByTestId('change-scope-count').textContent).toBe(
      '1 job to replace: 1 image',
    );
    expect(screen.getByTestId('change-run')).not.toBeDisabled();

    await user.click(screen.getByTestId('change-run'));
    const confirm = screen.getByTestId('change-confirm');
    expect(confirm.textContent).toContain('Replace 1 image?');

    runGenerationSelection.mockResolvedValue(
      report(
        module,
        world(module),
        {
          texts: [],
          images: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
          battlemaps: false,
          mobPortraits: false,
        },
        { imageJobs: 1, regenerated: 1 },
      ),
    );
    await user.click(screen.getByTestId('change-confirm-run'));
    await waitFor(() => {
      expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    });
    // THE RUN CREATES NOTHING: an empty generation half, and the change scope it
    // was asked for — this is what keeps the two dialogs' work apart.
    const input = runGenerationSelection.mock.calls[0]?.[0];
    expect(input?.kinds).toEqual([]);
    expect(input?.imageKinds).toEqual([]);
    expect(input?.encounterExtras).toEqual({ battlemaps: false, mobPortraits: false });
    expect(input?.change).toEqual({
      texts: [],
      images: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
      battlemaps: false,
      mobPortraits: false,
    });
    await actDrained(() => Promise.resolve());
  });

  it('a ticked half redoes exactly its own kind', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    renderDialog(module, world(module));

    await user.click(screen.getByTestId('change-images-npc'));
    expect(screen.getByTestId('change-scope-count').textContent).toBe(
      '1 job to replace: 1 image',
    );
    // …and the same dialog's Texts half stays empty.
    await user.click(screen.getByTestId('change-texts-npc'));
    expect(screen.getByTestId('change-scope-count').textContent).toBe(
      '2 jobs to replace: 1 text, 1 image',
    );
  });

  it('TEXTS redo the written rows, name the row this module does not own, and say the encounter redraws its map', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    renderDialog(module, world(module));

    await user.click(screen.getByTestId('change-texts-npc'));
    await user.click(screen.getByTestId('change-texts-location'));
    await user.click(screen.getByTestId('change-texts-encounter'));

    // Kael, Ash Gate and the encounter are this module's own written rows; Mira
    // belongs to the campaign and is NAMED rather than silently skipped.
    expect(screen.getByTestId('change-scope-count').textContent).toBe(
      '3 jobs to replace: 3 texts',
    );
    expect(screen.getByTestId('change-scope-kept').textContent).toContain('Mira');
    expect(screen.getByTestId('change-scope-kept').textContent).toContain(
      'not this module’s own entity — change it where it lives',
    );
    // Redoing the encounter's text regenerates it in full, map included
    // (docs/17 row 423) — the dialog says so.
    expect(screen.getByTestId('change-scope-encounters').textContent).toContain(
      'redraws the battlemap',
    );
  });

  it('the encounter extras are their own ticks and count separately', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    renderDialog(module, world(module));

    await user.click(screen.getByTestId('change-mob-portraits'));
    expect(screen.getByTestId('change-scope-count').textContent).toBe(
      '1 job to replace: 1 encounter’s mob portraits',
    );
    await user.click(screen.getByTestId('change-battlemaps'));
    expect(screen.getByTestId('change-scope-count').textContent).toBe(
      '2 jobs to replace: 1 battlemap, 1 encounter’s mob portraits',
    );
  });

  it('the run is NOT started until the confirmation is confirmed', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    renderDialog(module, world(module));

    await user.click(screen.getByTestId('change-images-npc'));
    await user.click(screen.getByTestId('change-run'));
    expect(screen.getByTestId('change-confirm')).toBeDefined();
    expect(runGenerationSelection).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('change-confirm-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('change-confirm')).toBeNull();
    });
    expect(runGenerationSelection).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  cleanup();
});
