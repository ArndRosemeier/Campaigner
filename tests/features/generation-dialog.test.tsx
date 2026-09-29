import { actDrained } from '../helpers/flush';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCampaign,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type AnyArtifact,
  type Campaign,
  type Module,
} from '@/domain';
import { readSettings, updateSettings } from '@/db/settingsRepo';
import { clearDatabase } from '../db/helpers';
import { GenerationDialog } from '@/features/modules/generation-dialog';
import { selectGenerationTargets } from '@/features/modules/generation-selection';
import type { GenerationRunInput, GenerationRunReport } from '@/features/modules/generation-run';

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

vi.mock('@/features/modules/generation-run', () => ({
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
      imageJobs: 0,
      mapJobs: 0,
      portraitJobs: 0,
      refused: null,
      classified: [],
      stopped: false,
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
      }),
      generated: 0,
      imageJobs: 0,
      mapJobs: 0,
      portraitJobs: 0,
      refused: null,
      classified: [],
      stopped: false,
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
    });
    await user.click(screen.getByTestId('generation-image-npc'));
    await waitFor(() => {
      expect(screen.getByTestId('generation-scope-count').textContent).toContain(`${String(before.images.length)} image`);
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
      selection: selectGenerationTargets({ module, artifacts: ARTIFACTS, kinds: ['npc'], imageKinds: ['npc'], levelRange: { min: 1, max: 3 } }),
      generated: 0, imageJobs: 0, mapJobs: 0, portraitJobs: 0, refused: null, classified: [], stopped: false,
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
