import { actDrained } from '../helpers/flush';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createArtifact,
  createCampaign,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type AnyArtifact,
  type Campaign,
  type Module,
} from '@/domain';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { adoptionArenaLayout } from '../helpers/battle-map-fixtures';
import { clearDatabase } from '../db/helpers';
import { GenerationDialog } from '@/features/modules/generation-dialog';
import { selectGenerationTargets } from '@/features/modules/generation-selection';
import {
  generationRunJobId,
  type GenerationRunInput,
  type GenerationRunReport,
} from '@/features/modules/generation-run';
import type * as generationRunModule from '@/features/modules/generation-run';
import { useProgressStore } from '@/lib/progress';

/**
 * THE GENERATION DIALOG (docs/23 §7, docs/17 row 394).
 *
 * The owner's requirement this file pins: the dialog *"states its own scope
 * before it runs (levels, kinds, target count) so an empty or surprising
 * selection is visible before any work starts, and it asks for confirmation when
 * the selection is wide"*. So the pins are:
 *
 * 1. THE SCOPE STATEMENT IS TRUE — the count it prints is the number the ONE
 *    selection seam returns for the same ticks (and the run is dispatched with
 *    exactly that selection);
 * 2. THE PREMISE BUCKET IS NAMED in both directions — left out by default, and
 *    included when the low bound moves to the premise;
 * 3. A WIDE selection asks a second, explicit question before anything starts;
 * 4. nothing runs until the button is pressed.
 */

const runGenerationSelection = vi.fn<
  (input: GenerationRunInput) => Promise<GenerationRunReport>
>(() => {
  throw new Error('the run must not be called by this arm');
});

vi.mock('@/features/modules/generation-run', async (importOriginal) => ({
  // The run's dock-entry id is the REAL one (docs/17 row 419): the dialog
  // reads the progress store through it.
  generationRunJobId: (await importOriginal<typeof generationRunModule>())
    .generationRunJobId,
  runGenerationSelection: (input: GenerationRunInput) => runGenerationSelection(input),
}));
vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

const CAMPAIGN: Campaign = createCampaign({ name: 'The Harbor', system: 'dnd5e' });

/** The document the pins read — premise plus three sections, five linked names. */
const SECTIONS = [
  '[[Kael]] meets [[Mira]] at the [[Ash Gate]].',
  '[[Kael]] travels to [[Old Keep]] and hears about [[Mira]].',
  'Nothing new here but [[High Hall]].',
];

const ENTITY_KINDS = [
  { name: 'Ash Gate', kind: 'location' as const },
  { name: 'Drowned Gate', kind: 'location' as const },
  { name: 'Kael', kind: 'npc' as const },
  { name: 'Mira', kind: 'npc' as const },
  { name: 'Old Keep', kind: 'location' as const },
  { name: 'High Hall', kind: 'location' as const },
].map((entry) => ({
  ...entry,
  absorbed: [],
  // STRICT LEVELS (docs/17 row 401): an NPC is generated only with a STATED level.
  ...(entry.kind === 'npc' ? { levelHint: 3 } : {}),
}));

function moduleFixture(): Module {
  const base = createModule({
    campaignId: CAMPAIGN.id,
    title: 'The Harbor',
    concept: '',
    levelMin: 1,
    levelMax: 3,
    sizeDial: 'sketch',
  });
  return {
    ...base,
    entityKinds: ENTITY_KINDS,
    spine: moduleSpineSchema.parse({
      premise: 'The harbor hides the [[Drowned Gate]].',
      themes: [],
      partPlan: SECTIONS.map((_, index) => ({
        title: `Level ${String(index + 1)}`,
        levelBand: String(index + 1),
        synopsis: '',
        levelUpTrigger: '',
      })),
    }),
    parts: SECTIONS.map((markdown, planIndex) =>
      modulePartSchema.parse({
        planIndex,
        markdown,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ),
  };
}

const ARTIFACTS: readonly AnyArtifact[] = [];

function renderDialog(module: Module) {
  const onOpenChange = vi.fn();
  render(
    <GenerationDialog
      module={module}
      campaign={CAMPAIGN}
      artifacts={ARTIFACTS}
      open
      onOpenChange={onOpenChange}
      blockedReason={null}
    />,
  );
  return { onOpenChange };
}

beforeEach(async () => {
  runGenerationSelection.mockReset();
  useProgressStore.getState().reset();
  await clearDatabase();
});

describe('the scope statement', () => {
  it('prints the count the ONE selection seam returns, and THE SAME selection runs', async () => {
    const module = moduleFixture();
    const expected = selectGenerationTargets({
      module,
      artifacts: ARTIFACTS,
      kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
      imageKinds: [],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
    });
    expect(expected.totalCount).toBe(5);

    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(module);

    expect(screen.getByTestId('generation-scope-count').textContent).toContain('5 jobs');
    expect(screen.getByTestId('generation-scope-summary').textContent).toContain(
      'Levels: Level 1 – Level 3',
    );
    expect(screen.getByTestId('generation-scope-levels').textContent).toBe(
      'Level 1: 3 · Level 2: 1 · Level 3: 1',
    );
    // The dedupe rule is SAID, not silently applied.
    expect(screen.getByTestId('generation-scope-dedupe').textContent).toContain(
      'Kael (Level 1; also Level 2)',
    );

    expect(runGenerationSelection).not.toHaveBeenCalled();
    runGenerationSelection.mockResolvedValue({
      selection: expected,
      generated: 5,
      regenerated: 0,
      imageJobs: 0,
      mapJobs: 0,
      portraitJobs: 0,
      refused: null,
      classified: [],
      stopped: false,
      notes: [],
    });

    await user.click(screen.getByTestId('generation-run'));

    await waitFor(() => {
      expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    });
    const input = runGenerationSelection.mock.calls[0]?.[0];
    expect(input?.kinds).toEqual(['npc', 'location', 'event', 'faction', 'note', 'encounter']);
    expect(input?.levelRange).toEqual({ min: 1, max: 3 });
    // What it announced is what it ran.
    expect(
      selectGenerationTargets({
        module,
        artifacts: ARTIFACTS,
        kinds: input?.kinds ?? [],
        imageKinds: input?.imageKinds ?? [],
        levelRange: input?.levelRange ?? { min: 1, max: 1 },
        encounterExtras: input?.encounterExtras ?? { battlemaps: false, mobPortraits: false },
      }).totalCount,
    ).toBe(5);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('re-derives on a tick: unticking a kind moves the announced count', async () => {
    const user = userEvent.setup();
    renderDialog(moduleFixture());

    expect(screen.getByTestId('generation-scope-count').textContent).toContain('5 jobs');

    // Locations: Ash Gate (1), Old Keep (2), High Hall (3) — 3 of the 5.
    await user.click(screen.getByTestId('generation-kind-location'));
    expect(screen.getByTestId('generation-scope-count').textContent).toContain('2 jobs');
  });

  it('is OFF until ticked for the encounter extras, and says so in the count', async () => {
    const user = userEvent.setup();
    renderDialog(moduleFixture());

    expect(screen.getByTestId('generation-battlemaps').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('generation-mob-portraits').getAttribute('aria-checked')).toBe(
      'false',
    );
    // No battlemap/portrait work is announced while both are unticked.
    expect(screen.getByTestId('generation-scope-count').textContent).toContain('0 battlemaps');
    expect(screen.getByTestId('generation-scope-count').textContent).toContain('0 mob portraits');

    await user.click(screen.getByTestId('generation-battlemaps'));
    expect(screen.getByTestId('generation-battlemaps').getAttribute('aria-checked')).toBe('true');
  });
});

describe('the dialog closes the moment Generate is pressed (docs/17 row 419)', () => {
  it('closes before the run settles, and a reopened dialog stays disabled while the run lives', async () => {
    const module = moduleFixture();
    let settle: (report: GenerationRunReport) => void = () => undefined;
    runGenerationSelection.mockImplementation(async () => {
      // What the real run does first: its own dock entry is the run's life.
      useProgressStore.getState().start(generationRunJobId(module.id), 'Generate details');
      const report = await new Promise<GenerationRunReport>((resolve) => {
        settle = resolve;
      });
      useProgressStore.getState().finish(generationRunJobId(module.id));
      return report;
    });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(module);

    await user.click(screen.getByTestId('generation-run'));

    // Closed while the run is still pending — not when it finishes.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    cleanup();

    // Reopened mid-run: the Generate control is disabled and says why.
    renderDialog(module);
    expect(screen.getByTestId('generation-run')).toBeDisabled();

    await act(async () => {
      settle({
        selection: selectGenerationTargets({
          module,
          artifacts: ARTIFACTS,
          kinds: ['npc'],
          imageKinds: [],
          levelRange: { min: 1, max: 3 },
          encounterExtras: { battlemaps: false, mobPortraits: false },
        }),
        generated: 1,
        regenerated: 0,
        imageJobs: 0,
        mapJobs: 0,
        portraitJobs: 0,
        refused: null,
        classified: [],
        stopped: false,
        notes: [],
      });
      await Promise.resolve();
    });
    expect(screen.getByTestId('generation-run')).not.toBeDisabled();
  });
});

describe('the premise bucket is an explicit, named answer', () => {
  it('names the premise-only entities it is leaving out, and includes them at the premise bound', async () => {
    const user = userEvent.setup();
    renderDialog(moduleFixture());

    expect(screen.getByTestId('generation-scope-premise').textContent).toBe(
      '1 premise-only entity has no level yet and is NOT selected — set "From level" to Premise (no level yet) to include it.',
    );

    await user.click(screen.getByTestId('generation-level-min'));
    await user.click(screen.getByRole('option', { name: 'Premise (no level yet)' }));

    expect(screen.getByTestId('generation-scope-premise').textContent).toContain(
      'no level yet — included in "Premise (no level yet)"',
    );
    // The bucket is counted, so the scope grew by exactly one entity.
    expect(screen.getByTestId('generation-scope-count').textContent).toContain('6 jobs');
  });
});

describe('a wide selection asks first', () => {
  it('opens the confirmation and runs only on its own press', async () => {
    const user = userEvent.setup();
    // Six kinds make the selection wide: this document's own 5 targets would
    // not, so the fixture is widened with a level-4 section carrying 8 names.
    const module = moduleFixture();
    const many = Array.from({ length: 8 }, (_, index) => `[[Name ${String(index)}]]`);
    const widened: Module = {
      ...module,
      entityKinds: [
        ...module.entityKinds,
        ...Array.from({ length: 8 }, (_, index) => ({
          name: `Name ${String(index)}`,
          kind: 'note' as const,
          absorbed: [],
        })),
      ],
      spine: moduleSpineSchema.parse({
        premise: module.spine?.premise ?? '',
        themes: [],
        partPlan: [...SECTIONS, 'level four'].map((_, index) => ({
          title: `Level ${String(index + 1)}`,
          levelBand: String(index + 1),
          synopsis: '',
          levelUpTrigger: '',
        })),
      }),
      parts: [
        ...module.parts,
        modulePartSchema.parse({
          planIndex: 3,
          markdown: many.join(' '),
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
    };
    renderDialog(widened);

    const announced = screen.getByTestId('generation-run').textContent;
    expect(announced).toContain('13 jobs');

    await user.click(screen.getByTestId('generation-run'));
    // Nothing ran: the second question is open.
    expect(runGenerationSelection).not.toHaveBeenCalled();
    expect(screen.getByTestId('generation-wide-confirm')).toBeTruthy();

    runGenerationSelection.mockResolvedValue({
      selection: selectGenerationTargets({
        module: widened,
        artifacts: ARTIFACTS,
        kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
        imageKinds: [],
        levelRange: { min: 1, max: 4 },
        encounterExtras: { battlemaps: false, mobPortraits: false },
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
    });
    await user.click(screen.getByTestId('generation-wide-confirm-run'));
    await waitFor(() => {
      expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    });
  });
});

describe('per-kind images (docs/17 row 397)', () => {
  it('is none by default, toggling a kind changes the printed count, and the preference round-trips', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    const first = render(
      <GenerationDialog module={module} campaign={CAMPAIGN} artifacts={ARTIFACTS} open onOpenChange={vi.fn()} blockedReason={null} />,
    );
    expect(screen.getByTestId('generation-scope-count').textContent).toContain('0 images');
    const before = selectGenerationTargets({
      module, artifacts: ARTIFACTS, kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'], imageKinds: ['npc'], levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
    });
    await user.click(screen.getByTestId('generation-image-npc'));
    await waitFor(() => {
      // MIGRATED (docs/17 row 406): the printed plan count is the existing
      // images PLUS the pending ones the run's detail pass will unlock. The
      // fixture has no artifacts yet, so this is purely the pending half — two
      // npcs this run creates (Kael, Mira), each of which then gets an image.
      const planned = before.images.length + before.pendingImages.length;
      expect(planned).toBe(2);
      expect(screen.getByTestId('generation-scope-count').textContent).toContain(
        `${String(planned)} image`,
      );
    });
    // The dialog reads the preference through a live query: a bare await here
    // lets its update land outside act() (docs/08-TESTING.md 1a, row 393).
    expect((await actDrained(() => readSettings())).generationImageKinds).toEqual(['npc']);
    first.unmount();
    // A fresh dialog opens with the stored choice.
    render(
      <GenerationDialog module={module} campaign={CAMPAIGN} artifacts={ARTIFACTS} open onOpenChange={vi.fn()} blockedReason={null} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('generation-image-npc').getAttribute('aria-checked')).toBe('true');
    });
    expect(screen.getByTestId('generation-image-location').getAttribute('aria-checked')).toBe('false');
    expect(runGenerationSelection).not.toHaveBeenCalled();
  });

  it('runs with exactly the imageKinds the count was printed for', async () => {
    await updateSettings({ generationImageKinds: ['npc'] });
    const user = userEvent.setup();
    const module = moduleFixture();
    renderDialog(module);
    await waitFor(() => {
      expect(screen.getByTestId('generation-image-npc').getAttribute('aria-checked')).toBe('true');
    });
    runGenerationSelection.mockResolvedValue({
      selection: selectGenerationTargets({ module, artifacts: ARTIFACTS, kinds: ['npc'], imageKinds: ['npc'], levelRange: { min: 1, max: 3 }, encounterExtras: { battlemaps: false, mobPortraits: false } }),
      generated: 0, regenerated: 0, imageJobs: 0, mapJobs: 0, portraitJobs: 0, refused: null, classified: [], stopped: false, notes: [],
    });
    await user.click(screen.getByTestId('generation-run'));
    await waitFor(() => {
      expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    });
    expect(runGenerationSelection.mock.calls[0]?.[0].imageKinds).toEqual(['npc']);
  });
});

describe('strict levels and the per-level encounter minimum (docs/17 row 401)', () => {
  it('an NPC with NO stated level is held out of the run and NAMED — the seam and the dialog agree', () => {
    const base = moduleFixture();
    const module: Module = {
      ...base,
      // Kael loses his stated level; Mira keeps hers.
      entityKinds: base.entityKinds.map((entry) =>
        entry.name === 'Kael' ? { ...entry, levelHint: undefined } : entry,
      ),
    };
    const seam = selectGenerationTargets({
      module,
      artifacts: ARTIFACTS,
      kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
      imageKinds: [],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: false, mobPortraits: false },
    });
    expect(seam.needsLevel.map((target) => target.name)).toEqual(['Kael']);
    expect(seam.detail.map((target) => target.name)).not.toContain('Kael');
    renderDialog(module);
    expect(screen.getByTestId('generation-scope-needs-level').textContent).toContain('Kael');
    expect(screen.getByTestId('generation-scope-count').textContent).toContain(
      `${String(seam.totalCount)} job`,
    );
    // The same problem list the chat card shows.
    expect(screen.getByTestId('generation-level-problems').textContent).toContain('«Kael»');
  });

  it('prints the per-level encounter counts the ONE problem function returns, and saves the minimum on the row', async () => {
    const module = moduleFixture();
    const { saveModule, getModule } = await import('@/db/moduleRepo');
    await saveModule(module);
    renderDialog(module);
    const counts = screen.getByTestId('generation-floor-counts').textContent;
    expect(counts).toContain('Level 1: 0/1');
    expect(counts).toContain('Level 3: 0/1');
    // The prop is static here (no live query), so drive the change event directly.
    fireEvent.change(screen.getByTestId('generation-floor-per-level'), { target: { value: '2' } });
    await waitFor(async () => {
      expect((await getModule(module.id))?.encounterFloorGuardrail).toEqual({ enabled: true, perLevel: 2 });
    });
  });
});

describe('the dialog counts equal the floor seam (docs/17 rows 394/401)', () => {
  it('per-level encounter counts from the problem function equal countModuleEncounters', async () => {
    const { countModuleEncounters } = await import('@/llm/moduleGen');
    const { deriveLevelProblems } = await import('@/domain');
    const { moduleDocumentFromView } = await import('@/domain');
    const base = moduleFixture();
    const module: Module = {
      ...base,
      entityKinds: [...base.entityKinds, { name: 'Ash Fight', kind: 'encounter', absorbed: [] }],
      parts: base.parts.map((part, index) =>
        index === 1 ? { ...part, markdown: `${part.markdown} [[Ash Fight]]` } : part,
      ),
    };
    const report = deriveLevelProblems({
      document: moduleDocumentFromView(module),
      entityKinds: module.entityKinds,
      floor: module.encounterFloorGuardrail,
    });
    const seam = countModuleEncounters(module);
    expect(report.encounterCounts.map((entry) => entry.found)).toEqual(seam.perPart.map((entry) => entry.found));
    expect(report.encounterCounts.map((entry) => entry.found)).toEqual([0, 1, 0]);
  });
});

/**
 * A TICKED KIND THAT PRODUCED NOTHING IS NAMED (docs/17 row 406). The run owns
 * the reason; the dialog's old fallback sentence ("every selected entity already
 * has its detail, image and map") must never contradict a run that just said a
 * ticked kind was skipped for a specific reason.
 */
describe('a ticked kind that produced nothing is NAMED, never a silent finish (docs/17 row 406)', () => {
  async function runWith(notes: string[]): Promise<void> {
    const { toastInfo } = await import('@/lib/toast');
    vi.mocked(toastInfo).mockReset();
    const user = userEvent.setup();
    const module = moduleFixture();
    renderDialog(module);
    runGenerationSelection.mockResolvedValue({
      selection: selectGenerationTargets({
        module,
        artifacts: ARTIFACTS,
        kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
        imageKinds: [],
        levelRange: { min: 1, max: 3 },
        encounterExtras: { battlemaps: false, mobPortraits: false },
      }),
      generated: 0,
      regenerated: 0,
      imageJobs: 0,
      mapJobs: 0,
      portraitJobs: 0,
      refused: null,
      classified: [],
      stopped: false,
      notes,
    });
    await user.click(screen.getByTestId('generation-run'));
    await waitFor(() => {
      expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    });
    return;
  }

  it('does not print "everything already has its image" over a run that named its reasons', async () => {
    const { toastInfo } = await import('@/lib/toast');
    await runWith([
      'images were NOT queued — no selected entity without an image exists after this run',
    ]);
    expect(vi.mocked(toastInfo)).not.toHaveBeenCalled();
  });

  it('keeps the honest fallback when the run reported no reason at all', async () => {
    const { toastInfo } = await import('@/lib/toast');
    await runWith([]);
    await waitFor(() => {
      expect(vi.mocked(toastInfo)).toHaveBeenCalledWith(
        'Nothing to generate — every selected entity already has its detail, image and map.',
      );
    });
  });
});

/**
 * THE OVERWRITE BOX (docs/17 row 422). The owner asked for *"an overwrite
 * checkbox (with confirmation if there is something to overwrite)"*. So: the box
 * is off by default; ticked, Generate asks ONE question (the wide-selection
 * confirmation, never a second stacked one) ONLY when the seam reports something
 * to replace; the question names the per-kind counts; Cancel runs nothing.
 */
describe('the overwrite box (docs/17 row 422)', () => {
  /** Kael (npc) and Ash Gate (location) are already detailed by this module. */
  function existing(module: Module): AnyArtifact[] {
    return (['Kael', 'Ash Gate'] as const).map((name) =>
      createArtifact({
        campaignId: CAMPAIGN.id,
        moduleId: module.id,
        kind: name === 'Kael' ? 'npc' : 'location',
        name,
        summary: 'Written by the old model.',
        body: '',
      }),
    );
  }

  function renderWith(module: Module, artifacts: readonly AnyArtifact[]): void {
    render(
      <GenerationDialog
        module={module}
        campaign={CAMPAIGN}
        artifacts={artifacts}
        open
        onOpenChange={vi.fn()}
        blockedReason={null}
      />,
    );
  }

  const REPORT = {
    generated: 0,
    regenerated: 0,
    imageJobs: 0,
    mapJobs: 0,
    portraitJobs: 0,
    refused: null,
    classified: [],
    stopped: false,
    notes: [],
  };

  it('is OFF by default: existing work is not counted and Generate asks nothing', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    const artifacts = existing(module);
    renderWith(module, artifacts);

    expect(screen.getByTestId('generation-overwrite').getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('generation-scope-overwrite')).toBeNull();
    // Three names still need their detail (Mira, Old Keep, High Hall).
    expect(screen.getByTestId('generation-scope-count').textContent).toContain('3 jobs');

    runGenerationSelection.mockResolvedValue({
      selection: selectGenerationTargets({
        module,
        artifacts,
        kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
        imageKinds: [],
        levelRange: { min: 1, max: 3 },
        encounterExtras: { battlemaps: false, mobPortraits: false },
      }),
      ...REPORT,
    });
    await user.click(screen.getByTestId('generation-run'));
    await waitFor(() => {
      expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('generation-wide-confirm')).toBeNull();
    expect(runGenerationSelection.mock.calls[0]?.[0].overwrite).toBe(false);
  });

  it('ticked with NOTHING to replace: the scope says so and Generate still asks nothing', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    renderWith(module, ARTIFACTS);

    await user.click(screen.getByTestId('generation-overwrite'));
    expect(screen.getByTestId('generation-scope-overwrite').textContent).toBe(
      'Overwrite: nothing selected exists yet — nothing is replaced.',
    );
    runGenerationSelection.mockResolvedValue({
      selection: selectGenerationTargets({
        module,
        artifacts: ARTIFACTS,
        kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
        imageKinds: [],
        levelRange: { min: 1, max: 3 },
        encounterExtras: { battlemaps: false, mobPortraits: false },
        overwrite: true,
      }),
      ...REPORT,
    });
    await user.click(screen.getByTestId('generation-run'));
    await waitFor(() => {
      expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('generation-wide-confirm')).toBeNull();
  });

  it('ticked with existing work: ONE confirmation naming the per-kind counts; Cancel runs nothing, Confirm runs the overwrite', async () => {
    const user = userEvent.setup();
    const module = moduleFixture();
    const artifacts = existing(module);
    renderWith(module, artifacts);

    await user.click(screen.getByTestId('generation-overwrite'));
    // The printed count is still the seam's own: 3 missing + 2 replaced.
    expect(screen.getByTestId('generation-scope-count').textContent).toContain(
      '5 jobs — 5 details',
    );
    expect(screen.getByTestId('generation-scope-overwrite').textContent).toBe(
      'Overwrite: 2 details already exist and will be replaced.',
    );

    await user.click(screen.getByTestId('generation-run'));
    // Nothing ran: the question is open, and it names what is replaced.
    expect(runGenerationSelection).not.toHaveBeenCalled();
    const confirm = screen.getByTestId('generation-wide-confirm');
    expect(confirm.textContent).toContain('Replace existing work and start 5 generation jobs?');
    expect(screen.getByTestId('generation-overwrite-counts').textContent).toBe(
      'Overwrite replaces 2 details.',
    );
    expect(confirm.textContent).toContain('previous text stays restorable');
    expect(confirm.textContent).not.toContain('nothing already generated is replaced');

    await user.click(screen.getByTestId('generation-wide-confirm-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('generation-wide-confirm')).toBeNull();
    });
    expect(runGenerationSelection).not.toHaveBeenCalled();

    runGenerationSelection.mockResolvedValue({
      selection: selectGenerationTargets({
        module,
        artifacts,
        kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
        imageKinds: [],
        levelRange: { min: 1, max: 3 },
        encounterExtras: { battlemaps: false, mobPortraits: false },
        overwrite: true,
      }),
      ...REPORT,
    });
    await user.click(screen.getByTestId('generation-run'));
    await user.click(screen.getByTestId('generation-wide-confirm-run'));
    await waitFor(() => {
      expect(runGenerationSelection).toHaveBeenCalledTimes(1);
    });
    expect(runGenerationSelection.mock.calls[0]?.[0].overwrite).toBe(true);
  });

  it('an existing encounter is regenerated IN FULL: the confirmation says its battlemap is redrawn, and no map job is counted (docs/17 row 423)', async () => {
    const user = userEvent.setup();
    const base = moduleFixture();
    // The harbor plus one levelled encounter the module links.
    const module: Module = {
      ...base,
      entityKinds: [
        ...base.entityKinds,
        { name: 'Ash Fight', kind: 'encounter', absorbed: [], levelHint: 3 },
      ],
      parts: base.parts.map((part, index) =>
        index === 0 ? { ...part, markdown: `${part.markdown} [[Ash Fight]]` } : part,
      ),
    };
    const MAP = '00000000-0000-4000-8000-0000000000aa';
    const blank = createArtifact({
      campaignId: CAMPAIGN.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ash Fight',
      summary: 'Goblins at the gate.',
      body: '',
    });
    if (blank.kind !== 'encounter') throw new Error('fixture: not an encounter');
    // MAPPED — so without row 423 the overwrite would ALSO count a map redraw.
    const encounter: AnyArtifact = {
      ...blank,
      imageIds: [MAP],
      data: { ...blank.data, layout: adoptionArenaLayout('4:3'), mapImageId: MAP },
    };
    const artifacts = [...existing(module), encounter];
    renderWith(module, artifacts);

    await user.click(screen.getByTestId('generation-battlemaps'));
    await user.click(screen.getByTestId('generation-overwrite'));
    const selection = selectGenerationTargets({
      module,
      artifacts,
      kinds: ['npc', 'location', 'event', 'faction', 'note', 'encounter'],
      imageKinds: [],
      levelRange: { min: 1, max: 3 },
      encounterExtras: { battlemaps: true, mobPortraits: false },
      overwrite: true,
    });
    // The printed plan IS the run's plan: 3 missing + 3 regenerated details,
    // and NO battlemap job (the regeneration draws it).
    expect(selection.totalCount).toBe(6);
    expect(screen.getByTestId('generation-scope-count').textContent).toBe(
      '6 jobs — 6 details, 0 images, 0 battlemaps, 0 mob portraits',
    );

    await user.click(screen.getByTestId('generation-run'));
    const confirm = screen.getByTestId('generation-wide-confirm');
    expect(confirm.textContent).toContain('Replace existing work and start 6 generation jobs?');
    expect(screen.getByTestId('generation-overwrite-counts').textContent).toBe(
      'Overwrite replaces 3 details.',
    );
    expect(screen.getByTestId('generation-overwrite-encounters').textContent).toContain(
      'Regenerating an encounter redraws its battlemap',
    );
    expect(screen.getByTestId('generation-overwrite-encounters').textContent).toContain(
      '1 encounter is regenerated completely',
    );
    expect(screen.getByTestId('generation-overwrite-encounters').textContent).toContain(
      'the name is kept',
    );
    expect(screen.getByTestId('generation-wide-confirm-run').textContent).toBe('Generate 6 jobs');
  });
});
