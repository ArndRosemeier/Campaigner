/**
 * MERGED same-background cluster (docs/17 row 177, extending row 176's pilot):
 * six `tests/features` module-UI files that share ONE background —
 * fake-indexeddb + `clearDatabase()` and the SAME identical `vi.mock` target set
 * (`@/lib/toast`, `@/llm/moduleGen`, the latter as a partial mock with the real
 * module spread in) — now run in ONE file, so the
 * import/transform/jsdom-environment/setup cost is paid once instead of six
 * times.
 *
 * Merged from (one `describe` per original file, so each stays findable; test
 * names and every `expect` assertion site is byte-identical):
 *   - tests/features/modules-list.test.tsx (15)
 *   - tests/features/normalization-failure-wording.test.tsx (2)
 *   - tests/features/prompt-style-freestyle-ui.test.tsx (2)
 *   - tests/features/remove-all-generated.test.tsx (2)
 *   - tests/features/prompt-style-default-ui.test.tsx (3)
 *   - tests/features/cover-art.test.tsx (4)
 *
 * `cover-art` is placed LAST on purpose: its `beforeEach` mutates process-wide
 * globals by direct assignment (`Object.defineProperty(URL, 'createObjectURL' /
 * 'revokeObjectURL')`) that no afterEach restores, so every describe that does
 * not want that stub runs BEFORE it (sweep rule 4).
 */

import 'fake-indexeddb/auto';
import {
  act,
  render,
  screen,
  waitFor,
  within,
  cleanup,
  render as rtlRender,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '@/app/router';
import { modulesPath, modulePath, ROUTES } from '@/app/routes';
import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign, getCampaign, updateCampaign } from '@/db/campaignRepo';
import {
  getModule,
  patchModule,
  saveModule,
  createModule as createModule__2,
  createModule as saveModuleRow,
} from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  defaultModuleTitle,
  encounterDataSchema,
  modulePartSchema,
  moduleSpineSchema,
  createModule as buildModule,
} from '@/domain';
import type { Id, Module, Campaign } from '@/domain';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { EntityPanel } from '@/features/modules/entity-panel';
import { NORMALIZATION_FAILURE_MESSAGE } from '@/llm/moduleGen';
import { db } from '@/db/db';
import { NewModuleDialog } from '@/features/modules/new-module-dialog';
import { PromptStylesSection } from '@/features/settings/prompt-styles-section';
import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import { updateSettings } from '@/db/settingsRepo';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { createImage } from '@/db/imageRepo';

const { createModuleAndRun, normalizeModuleEntityNames } = await import('@/llm/moduleGen');
const { toastSuccess, toastError } = await import('@/lib/toast');

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

// The union of the six originals' partial and full `@/llm/moduleGen` mocks:
// the real module (so `moduleGenEvents` and every unmocked helper stay live for
// the router graph) with every generation entry point the originals stubbed.
vi.mock('@/llm/moduleGen', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    runSpine: vi.fn(),
    runParts: vi.fn(),
    approveSpineAndRun: vi.fn(),
    retrySpine: vi.fn(),
    discardSpine: vi.fn(),
    cancelModuleGen: vi.fn(),
    generateMissingParts: vi.fn(),
    rewritePart: vi.fn(),
    createModuleAndRun: vi.fn(),
    normalizeModuleEntityNames: vi.fn(),
  };
});

/**
 * Cross-describe mock isolation for the merge: each original owned its own mock
 * instance, so its own teardown sufficed. A merged file shares ONE instance per
 * mocked module (the point of the merge), so a leftover `mockImplementation` or
 * call history from an earlier describe would answer a later test's `...Once`
 * queue overflow and change its call counts. Reset before every test; each
 * describe's own hooks then install what it needs.
 */
beforeEach(() => {
  vi.resetAllMocks();
});

describe('modules-list.test.tsx', () => {
  /**
   * Module list (08-MODULE-DESIGNER M4-B): the campaign's modules with
   * status/progress badges, the "New Module" entry point (dialog opens, no LLM
   * path runs), and the confirmed delete flow (row gone from the DB).
   */

  // The whole generator is mocked: opening the New Module dialog must never
  // start an LLM run. `moduleGenEvents` (imported by the reader page in the
  // router graph) stays real via the spread.

  const createModuleAndRunMock = vi.mocked(createModuleAndRun);

  const toastSuccessMock = vi.mocked(toastSuccess);

  function renderAppAt(path: string): void {
    window.history.replaceState(null, '', path);
    render(<RouterProvider router={createAppRouter()} />);
  }

  async function seedModules(): Promise<{ campaignId: Id; draftId: Id; failedId: Id }> {
    await seedBuiltInPersonas();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

    // Draft with an approved spine and 2 of 3 parts written → "2/3 parts".
    const draft = createModule({
      campaignId: campaign.id,
      title: 'Vault of Whispers',
      concept: 'A whispering vault under the mill.',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
    });
    const draftSaved = await saveModule({
      ...draft,
      status: 'draft',
      spine: moduleSpineSchema.parse({
        premise: 'The old mill hides a vault of whispers.',
        themes: ['secrets'],
        partPlan: [
          {
            title: 'The Mill',
            levelBand: '1',
            synopsis: 'The party arrives.',
            levelUpTrigger: 'Descend.',
          },
          {
            title: 'The Whisper Hall',
            levelBand: '2',
            synopsis: 'Voices bargain.',
            levelUpTrigger: 'The door opens.',
          },
          {
            title: 'The Vault',
            levelBand: '3',
            synopsis: 'The vault is opened.',
            levelUpTrigger: 'Escape.',
          },
        ],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: 'The party reaches the mill at dusk.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        modulePartSchema.parse({
          planIndex: 1,
          markdown: 'Whispers answer the party’s questions.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        modulePartSchema.parse({
          planIndex: 2,
          markdown: '',
          status: 'pending',
          errorMessage: '',
          edited: false,
        }),
      ],
    });

    // Failed during the spine draft: no spine, loud error message.
    const failed = createModule({
      campaignId: campaign.id,
      title: 'Sunken Cult',
      concept: 'A cult beneath the lake.',
      levelMin: 2,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
    });
    const failedSaved = await saveModule({
      ...failed,
      status: 'failed',
      errorMessage: 'the spine draft failed',
    });

    return { campaignId: campaign.id, draftId: draftSaved.id, failedId: failedSaved.id };
  }

  beforeEach(() => {
    useProgressStore.getState().reset();
    return clearDatabase();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('ModulesListPage', () => {
    it('shows the live forge detail on the row of a module that is generating', async () => {
      const { campaignId, draftId } = await seedModules();
      renderAppAt(modulesPath(campaignId));
      const draftTitle = await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });
      const draftRow = draftTitle.closest('li');
      if (draftRow === null) throw new Error('draft module row missing');
      expect(within(draftRow).queryByTestId('module-forge-detail')).not.toBeInTheDocument();

      // The module-forge progress job (started by runParts) surfaces on the row.
      act(() => {
        useProgressStore
          .getState()
          .start(
            `module-parts-${draftId}`,
            'Writing 2 module parts',
            'Writing part 1 of 2: The Mill',
          );
      });

      await waitFor(() => {
        expect(within(draftRow).getByTestId('module-forge-detail')).toHaveTextContent(
          'Writing part 1 of 2: The Mill',
        );
      });
      act(() => {
        useProgressStore.getState().reset();
      });
      await flushAsyncUpdates();
    }, 20_000);

    it('renders both modules with their level/size/status badges', async () => {
      const { campaignId } = await seedModules();
      renderAppAt(modulesPath(campaignId));

      const draftTitle = await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });
      const draftRow = draftTitle.closest('li');
      if (draftRow === null) throw new Error('draft module row missing');
      expect(within(draftRow).getByTestId('module-progress')).toHaveTextContent('2/3 parts');
      expect(within(draftRow).getByText('1–3')).toBeInTheDocument();
      expect(within(draftRow).getByText('Standard')).toBeInTheDocument();

      const failedTitle = screen.getByText('Sunken Cult');
      const failedRow = failedTitle.closest('li');
      if (failedRow === null) throw new Error('failed module row missing');
      expect(within(failedRow).getByText('failed')).toBeInTheDocument();
      expect(within(failedRow).getByText('2–2')).toBeInTheDocument();
      expect(within(failedRow).getByText('Sketch')).toBeInTheDocument();
      // A failed module has no progress badge — the failed badge replaces it.
      expect(within(failedRow).queryByTestId('module-progress')).not.toBeInTheDocument();
      await flushAsyncUpdates();
    }, 20_000);

    it('opens the New Module dialog without starting a generation run', async () => {
      const user = userEvent.setup();
      const { campaignId } = await seedModules();
      renderAppAt(modulesPath(campaignId));
      await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

      await user.click(screen.getByTestId('new-module'));
      const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
      expect(within(dialog).getByRole('heading', { name: 'New Module' })).toBeInTheDocument();
      // The Name field is visibly present and pre-filled (docs/17 row 213),
      // distinct from the reader's `module-title` testid.
      expect(within(dialog).getByTestId('new-module-title')).toHaveValue(defaultModuleTitle());
      expect(createModuleAndRunMock).not.toHaveBeenCalled();

      // Cancel closes the dialog; still no generator call.
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(screen.queryByTestId('new-module-dialog')).not.toBeInTheDocument();
      });
      expect(createModuleAndRunMock).not.toHaveBeenCalled();
      await flushAsyncUpdates();
    }, 20_000);

    it('offers prior-module continuity and passes the opt-in to the generator', async () => {
      const user = userEvent.setup();
      // 'Vault of Whispers' carries a premise + written parts, so the opt-in
      // continuity checkbox is offered.
      const { campaignId } = await seedModules();
      renderAppAt(modulesPath(campaignId));
      await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

      await user.click(screen.getByTestId('new-module'));
      const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
      const checkbox = within(dialog).getByRole('checkbox', {
        name: 'Continue from previous modules',
      });
      await waitFor(() => {
        expect(checkbox).toBeEnabled();
      });

      await user.click(checkbox);
      expect(checkbox).toBeChecked();
      await user.type(within(dialog).getByLabelText('Concept'), 'A new chapter of the story.');
      createModuleAndRunMock.mockResolvedValue('00000000-0000-4000-8000-00000000feed');
      await user.click(within(dialog).getByTestId('start-module'));
      await waitFor(() => {
        expect(createModuleAndRunMock).toHaveBeenCalledTimes(1);
      });
      expect(createModuleAndRunMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ includePriorModules: true }),
      );
      await flushAsyncUpdates();
    }, 20_000);

    it('starts with continuity off and disables it when no prior module has text', async () => {
      const user = userEvent.setup();
      const campaign = await createCampaign({ name: 'Barren', system: 'dnd5e' });
      renderAppAt(modulesPath(campaign.id));
      await screen.findByTestId('new-module', {}, { timeout: 10_000 });

      await user.click(screen.getByTestId('new-module'));
      const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
      const checkbox = within(dialog).getByRole('checkbox', {
        name: 'Continue from previous modules',
      });
      // Base UI checkbox: the disabled state is aria-disabled, not [disabled].
      expect(checkbox).toHaveAttribute('aria-disabled', 'true');
      expect(
        within(dialog).getByText('No previous modules with text in this campaign yet.'),
      ).toBeInTheDocument();

      // Creation still works, and the flag is passed as off.
      await user.type(within(dialog).getByLabelText('Concept'), 'The very first chapter.');
      createModuleAndRunMock.mockResolvedValue('00000000-0000-4000-8000-00000000feed');
      await user.click(within(dialog).getByTestId('start-module'));
      await waitFor(() => {
        expect(createModuleAndRunMock).toHaveBeenCalledTimes(1);
      });
      expect(createModuleAndRunMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ includePriorModules: false }),
      );
      await flushAsyncUpdates();
    }, 20_000);

    it('passes the post-generation automation checkboxes to the generator', async () => {
      const user = userEvent.setup();
      const { campaignId } = await seedModules();
      renderAppAt(modulesPath(campaignId));
      await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

      await user.click(screen.getByTestId('new-module'));
      const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });

      // Default: the pass automations off, battlemaps ON (owner request:
      // automated encounters map automatically with the campaign's defaults),
      // mob portraits off (opt-in).
      expect(within(dialog).getByTestId('auto-generate-npc')).not.toBeChecked();
      expect(within(dialog).getByTestId('auto-image-npc')).not.toBeChecked();
      expect(within(dialog).getByTestId('auto-spine')).not.toBeChecked();
      expect(within(dialog).getByTestId('auto-battlemaps')).toBeChecked();
      expect(within(dialog).getByTestId('auto-mob-images')).not.toBeChecked();

      // Tick: unattended spine, auto-generate npcs + locations, auto-image npcs
      // + mob portraits; untick battlemaps to keep this module's maps manual.
      await user.click(within(dialog).getByTestId('auto-spine'));
      await user.click(within(dialog).getByTestId('auto-generate-npc'));
      await user.click(within(dialog).getByTestId('auto-generate-location'));
      await user.click(within(dialog).getByTestId('auto-image-npc'));
      await user.click(within(dialog).getByTestId('auto-battlemaps'));
      await user.click(within(dialog).getByTestId('auto-mob-images'));

      await user.type(within(dialog).getByLabelText('Concept'), 'Automated chapter.');
      createModuleAndRunMock.mockResolvedValue('00000000-0000-4000-8000-00000000feed');
      await user.click(within(dialog).getByTestId('start-module'));
      await waitFor(() => {
        expect(createModuleAndRunMock).toHaveBeenCalledTimes(1);
      });
      expect(createModuleAndRunMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          autoApproveSpine: true,
          autoGenerateKinds: ['npc', 'location'],
          autoImageKinds: ['npc'],
          autoGenerateBattlemaps: false,
          autoGenerateMobImages: true,
        }),
      );
      await flushAsyncUpdates();
    }, 20_000);

    it('deletes a module after confirmation and removes the row from the DB', async () => {
      const user = userEvent.setup();
      const { campaignId, failedId } = await seedModules();
      renderAppAt(modulesPath(campaignId));
      await screen.findByText('Sunken Cult', {}, { timeout: 10_000 });

      await user.click(screen.getByRole('button', { name: 'Delete Sunken Cult' }));
      const confirm = await screen.findByRole('alertdialog', {}, { timeout: 5_000 });
      expect(confirm).toHaveTextContent('Sunken Cult');
      await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

      await waitFor(
        async () => {
          expect(await getModule(failedId)).toBeUndefined();
        },
        { timeout: 10_000 },
      );
      await waitFor(() => {
        expect(screen.queryByText('Sunken Cult')).not.toBeInTheDocument();
      });
      expect(toastSuccessMock).toHaveBeenCalledWith('Module deleted');
      // The in-flight generation cancel is triggered on delete (best-effort —
      // a parts pass must not keep writing into a removed module).
      const { cancelModuleGen } = await import('@/llm/moduleGen');
      expect(cancelModuleGen).toHaveBeenCalledWith(failedId);
      await flushAsyncUpdates();
    }, 20_000);

    it('an artifact that lands after the dialog opened is cascaded, not released', async () => {
      const user = userEvent.setup();
      const { campaignId, failedId } = await seedModules();
      renderAppAt(modulesPath(campaignId));
      await screen.findByText('Sunken Cult', {}, { timeout: 10_000 });

      await user.click(screen.getByRole('button', { name: 'Delete Sunken Cult' }));
      await screen.findByRole('alertdialog', {}, { timeout: 5_000 });
      // The dialog counted ZERO owned artifacts ("Delete", keep-branch on the
      // stale count). An owned artifact lands while the dialog is open.
      const lateLooter = await createArtifact({
        campaignId,
        moduleId: failedId,
        kind: 'npc',
        name: 'Late Looter',
      });

      // Confirming must recount at confirm time: the fresh count (1) picks the
      // cascade branch — deleting the late artifact, never releasing it.
      await user.click(
        within(await screen.findByRole('alertdialog')).getByTestId('delete-module-confirm'),
      );

      await waitFor(
        async () => {
          expect(await getModule(failedId)).toBeUndefined();
          expect(await getArtifact(lateLooter.id)).toBeUndefined();
        },
        { timeout: 10_000 },
      );
      expect(toastSuccessMock).toHaveBeenCalledWith('Module deleted');
      await flushAsyncUpdates();
    }, 20_000);

    it('shows the campaign name and description in the landing header', async () => {
      const campaign = await createCampaign({
        name: 'Ember',
        description: 'A sunless sea beneath a dying star.',
        system: 'dnd5e',
      });
      renderAppAt(modulesPath(campaign.id));

      const context = await screen.findByTestId(
        'campaign-landing-context',
        {},
        { timeout: 10_000 },
      );
      expect(context).toHaveTextContent('Ember');
      expect(context).toHaveTextContent('A sunless sea beneath a dying star.');
      await flushAsyncUpdates();
    }, 20_000);

    it('drops the description from the landing header when it is empty', async () => {
      const campaign = await createCampaign({ name: 'Barren', system: 'dnd5e' });
      renderAppAt(modulesPath(campaign.id));

      const context = await screen.findByTestId(
        'campaign-landing-context',
        {},
        { timeout: 10_000 },
      );
      // Name only — no stray separator for the missing description.
      expect(context.textContent).toBe('Barren');
      await flushAsyncUpdates();
    }, 20_000);

    it('edits the campaign from the landing and refreshes the header', async () => {
      const user = userEvent.setup();
      const campaign = await createCampaign({
        name: 'Ember',
        description: 'Old description.',
        system: 'dnd5e',
      });
      renderAppAt(modulesPath(campaign.id));
      await screen.findByTestId('edit-campaign', {}, { timeout: 10_000 });

      await user.click(screen.getByTestId('edit-campaign'));
      const dialog = await screen.findByTestId('edit-campaign-dialog', {}, { timeout: 5_000 });
      expect(within(dialog).getByLabelText('Campaign name')).toHaveValue('Ember');
      expect(within(dialog).getByLabelText('Campaign description')).toHaveValue('Old description.');
      // The system is fixed — shown disabled, not editable.
      expect(within(dialog).getByLabelText('Game system (fixed)')).toBeDisabled();

      await user.clear(within(dialog).getByLabelText('Campaign description'));
      await user.type(within(dialog).getByLabelText('Campaign description'), 'A drowned city.');
      await user.click(within(dialog).getByTestId('save-campaign'));

      // Persisted through the repo…
      await waitFor(async () => {
        expect((await getCampaign(campaign.id))?.description).toBe('A drowned city.');
      });
      // …and the liveQuery header picked it up.
      await waitFor(() => {
        expect(screen.getByTestId('campaign-landing-context')).toHaveTextContent('A drowned city.');
      });
      await flushAsyncUpdates();
    }, 20_000);

    it('clears the description and removes it from the landing header', async () => {
      const user = userEvent.setup();
      const campaign = await createCampaign({
        name: 'Ember',
        description: 'Old description.',
        system: 'dnd5e',
      });
      renderAppAt(modulesPath(campaign.id));
      await screen.findByTestId('edit-campaign', {}, { timeout: 10_000 });

      await user.click(screen.getByTestId('edit-campaign'));
      const dialog = await screen.findByTestId('edit-campaign-dialog', {}, { timeout: 5_000 });
      await user.clear(within(dialog).getByLabelText('Campaign description'));
      await user.click(within(dialog).getByTestId('save-campaign'));

      await waitFor(() => {
        expect(screen.getByTestId('campaign-landing-context').textContent).toBe('Ember');
      });
      // Raw awaited read while the page + closing dialog are mounted —
      // actDrained closes the window the save write's liveQuery cascade and
      // the dialog exit chain used to leak through (docs/08 §Console guard);
      // the long trailing drain absorbs the exit transition's timed updates.
      expect(await actDrained(() => getCampaign(campaign.id))).toMatchObject({ description: '' });
      await flushAsyncUpdates(60);
    }, 20_000);
  });

  describe('ModulesListPage delete dialog blast radius (cited creatures)', () => {
    it('names the LIBRARY creatures its encounters cite as a reference, never as owned', async () => {
      const user = userEvent.setup();
      const { campaignId, draftId } = await seedModules();
      // REWRITTEN (ledger row 106): a cited creature is a LIBRARY row, so nothing
      // is created for it and the dialog's census speaks of citations, not of
      // shared mob artifacts. The old fixture created a campaign-scoped `npc`
      // artifact carrying `monsterChunkId` and cited it by `mobArtifactId` —
      // exactly the artifact whose deletion used to strand roster rows.
      const before = await listArtifactsByCampaign(campaignId);
      await createArtifact({
        campaignId,
        moduleId: draftId,
        kind: 'encounter',
        name: 'Mill Ambush',
        data: encounterDataSchema.parse({
          difficulty: 'medium',
          levelHint: '3',
          monsters: [
            {
              name: 'Goblin Boss',
              count: 2,
              notes: '',
              treasure: '',
              // A DANGLING npc-ref: the census speaks of library references
              // (docs/17 row 278 — a copy is the campaign's own row).
              source: {
                type: 'npc-ref',
                artifactId: '00000000-0000-4000-8000-0000000000aa',
              },
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
        }),
      });
      renderAppAt(modulesPath(campaignId));
      await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

      await user.click(screen.getByRole('button', { name: 'Delete Vault of Whispers' }));
      const confirm = await screen.findByRole('alertdialog', {}, { timeout: 5_000 });
      const census = await within(confirm).findByTestId(
        'delete-module-cited-mobs',
        {},
        { timeout: 5_000 },
      );
      expect(census).toHaveTextContent('Goblin Boss');
      expect(census).toHaveTextContent('creature from the bestiary');
      // Honest wording: a LIBRARY reference, not an owned artifact.
      expect(census).toHaveTextContent('Those are library references, not part of this module');
      // …and citing one created nothing: the only new row is the encounter.
      const after = await listArtifactsByCampaign(campaignId);
      expect(after).toHaveLength(before.length + 1);
      expect(after.some((row) => row.kind === 'npc')).toBe(false);
      await flushAsyncUpdates();
    }, 20_000);
  });

  describe('ModulesListPage delete third state (referenced artifacts)', () => {
    it('lists outside-referenced artifacts and promotes them on "Promote & keep"', async () => {
      const user = userEvent.setup();
      const { campaignId, draftId, failedId } = await seedModules();
      // The draft owns an npc; the failed module links it in its part text.
      const hexer = await createArtifact({
        campaignId,
        moduleId: draftId,
        kind: 'npc',
        name: 'Shared Hexer',
      });
      await patchModule(failedId, {
        parts: [
          {
            planIndex: 0,
            markdown: 'Hire [[Shared Hexer]].',
            status: 'ready',
            errorMessage: '',
            edited: true,
            writerModel: '',
            origin: null,
          },
        ],
      });
      renderAppAt(modulesPath(campaignId));
      await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

      await user.click(screen.getByRole('button', { name: 'Delete Vault of Whispers' }));
      const confirm = await screen.findByRole('alertdialog', {}, { timeout: 5_000 });
      const list = await within(confirm).findByTestId(
        'delete-module-referenced-list',
        {},
        { timeout: 5_000 },
      );
      expect(list).toHaveTextContent('Shared Hexer');
      expect(list).toHaveTextContent('wiki-link');

      await user.click(within(confirm).getByTestId('delete-module-promote-keep'));

      await waitFor(
        async () => {
          expect(await getModule(draftId)).toBeUndefined();
          expect((await getArtifact(hexer.id))?.moduleId).toBeNull();
        },
        { timeout: 10_000 },
      );
      expect(toastSuccessMock).toHaveBeenCalledWith(
        'Module deleted — referenced artifacts are now shared across the campaign',
      );
      await flushAsyncUpdates();
    }, 20_000);

    it('force-deletes referenced artifacts too when the user picks "Force-delete all"', async () => {
      const user = userEvent.setup();
      const { campaignId, draftId, failedId } = await seedModules();
      const hexer = await createArtifact({
        campaignId,
        moduleId: draftId,
        kind: 'npc',
        name: 'Shared Hexer',
      });
      await patchModule(failedId, {
        parts: [
          {
            planIndex: 0,
            markdown: 'Hire [[Shared Hexer]].',
            status: 'ready',
            errorMessage: '',
            edited: true,
            writerModel: '',
            origin: null,
          },
        ],
      });
      renderAppAt(modulesPath(campaignId));
      await screen.findByText('Vault of Whispers', {}, { timeout: 10_000 });

      await user.click(screen.getByRole('button', { name: 'Delete Vault of Whispers' }));
      const confirm = await screen.findByRole('alertdialog', {}, { timeout: 5_000 });
      await within(confirm).findByTestId('delete-module-referenced-list', {}, { timeout: 5_000 });

      await user.click(within(confirm).getByTestId('delete-module-confirm'));

      await waitFor(
        async () => {
          expect(await getModule(draftId)).toBeUndefined();
          expect(await getArtifact(hexer.id)).toBeUndefined();
        },
        { timeout: 10_000 },
      );
      expect(toastSuccessMock).toHaveBeenCalledWith('Module deleted');
      await flushAsyncUpdates();
    }, 20_000);
  });
});

describe('normalization-failure-wording.test.tsx', () => {
  /**
   * The failure sentence of the normalization pass is ONE wording (docs/17 row
   * 119). The audit that opened this slice found the named seam
   * (`recordNormalizationFailure`) bypassed by three inline copies of its body,
   * and the panel's own belt carried a fourth.
   *
   * These tests pin the part a toast spy cannot: that the wording is STATED once
   * in the source and everywhere else reads the seam. A behavioural assertion
   * cannot tell a copy from the shared constant — they are byte-identical by
   * requirement — so the fold is pinned by scanning the source, the way the
   * campaign tree pins "one plan dialog" (campaign-tree-plan-control.test.tsx).
   * The pass-side behaviour (recording, gating, the cancel guard) is pinned in
   * tests/llm/moduleGen.test.ts and tests/features/stop-canvas-normalization.test.ts.
   */

  /** The sentence, as a reader sees it — the pin, never read from the source. */
  const SENTENCE = 'Entity name normalization failed — retry from the entity panel';

  /**
   * The panel's BELT is the subject here — the catch for a throw the pass did not
   * record itself — so the pass is a mock. Everything else from the module stays
   * real (the same partial mock `stop-canvas-normalization.test.ts` uses).
   */

  const toastErrorMock = vi.mocked(toastError);

  const normalizeMock = vi.mocked(normalizeModuleEntityNames);

  let module: Module;
  let campaign: Awaited<ReturnType<typeof createCampaign>>;

  function moduleFixture(campaignId: Id): Module {
    const base = createModule({
      campaignId,
      title: 'Ember Crypt',
      concept: 'A crypt guarding an old seal.',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'sketch',
    });
    return {
      ...base,
      spine: moduleSpineSchema.parse({
        premise: 'The gate of [[Ember Crypt]] opens at dusk.',
        themes: [],
        partPlan: [{ title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: '## The Tide Gate\n\n[[Kael]] watches the gate and counts every visitor.',
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
      ],
      status: 'ready',
      // The failed-pass state the panel shows: the gate is closed, so its
      // "Normalize names" control is offered.
      entityNamesNormalized: false,
    };
  }

  beforeEach(async () => {
    await clearDatabase();
    vi.clearAllMocks();
    useProgressStore.getState().reset();
    campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    module = await saveModule(moduleFixture(campaign.id));
  });

  afterEach(cleanup);

  describe('the entity panel belt', () => {
    it('toasts the seam sentence when the pass throws before its own catch records anything', async () => {
      const user = userEvent.setup();
      rtlRender(
        <EntityPanel
          module={module}
          artifacts={[]}
          campaign={campaign}
          onStub={vi.fn()}
          onOpenCard={vi.fn()}
        />,
        { wrapper: MemoryRouter },
      );
      normalizeMock.mockRejectedValueOnce(new Error('the pass threw before it could record'));

      await user.click(screen.getByTestId('entity-normalize'));

      await waitFor(() => {
        expect(toastErrorMock).toHaveBeenCalledWith(
          NORMALIZATION_FAILURE_MESSAGE,
          expect.any(Error),
        );
      });
      // The panel imports the seam's sentence — it is not a second wording that
      // happens to match today (the source scan below is what enforces it).
      expect(NORMALIZATION_FAILURE_MESSAGE).toBe(SENTENCE);
    }, 20000);
  });

  describe('the failure sentence is ONE wording', () => {
    it('is stated in exactly one source file, and the panel reads it from there', () => {
      const root = resolve(import.meta.dirname, '..', '..');
      const files = sourceFiles(resolve(root, 'src'));
      // Non-vacuity: this really walked the source tree, so the scan below can
      // only pass because it read files at all.
      expect(files.length).toBeGreaterThan(50);

      const stated = files
        .filter((file) => readFileSync(file, 'utf8').includes(SENTENCE))
        .map((file) => relative(root, file));
      // A fourth copy of the wording anywhere in the app fails this — the shape
      // that drifted into a missing cancel guard once already.
      expect(stated).toEqual(['src/llm/moduleGen.ts']);

      // The two surfaces that must keep saying it reach it through the export:
      // the panel's belt, and the pass's own recording seam.
      const panel = readFileSync(
        resolve(root, 'src', 'features', 'modules', 'entity-panel.tsx'),
        'utf8',
      );
      expect(panel).toContain('NORMALIZATION_FAILURE_MESSAGE');
      expect(panel).not.toContain(SENTENCE);
      const gen = readFileSync(resolve(root, 'src', 'llm', 'moduleGen.ts'), 'utf8');
      // Exactly one statement of the sentence inside the seam…
      expect(gen.split(SENTENCE)).toHaveLength(2);
      // …and FIVE catches that go through the seam instead of restating it: the
      // post-parts pass, the re-normalization after a floor repair, the repair
      // pass, the full pass's own catch and the incremental classification's.
      expect(gen.match(/recordNormalizationFailure\(error\)/g)).toHaveLength(5);
    }, 20000);
  });

  /** Every `.ts`/`.tsx` file under `dir` (a small explicit walk — no glob dep). */
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(path));
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
    return found;
  }
});

describe('prompt-style-freestyle-ui.test.tsx', () => {
  /**
   * Freestyle is SELECTABLE, on both surfaces that offer a writing style
   * (docs/17 row 87).
   *
   * Both surfaces are data-driven — `PromptStylesSection` and the New Module
   * dialog's Writing style select each map `catalogStyles(catalog)`, which is
   * `BUILTIN_PROMPT_STYLES` plus the user's own — so these pins are deliberately
   * about the DATA reaching the two lists a user actually picks from, not about
   * any hand-added entry. REVERT-PROOF: removing the freestyle entry from
   * `BUILTIN_PROMPT_STYLES` makes both fail (the row and the option disappear),
   * which is exactly the failure a "the third style exists" claim must catch.
   *
   * The dialog's own selection semantics (the draft field, the app default, the
   * unresolvable id) belong to the row-86 arc and are pinned by
   * `new-module-draft.test.tsx`; nothing here duplicates or softens them.
   */

  // Creation must never start real LLM machinery here.

  beforeEach(async () => {
    await db.open();
    await clearDatabase();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('Freestyle is offered like the other built-ins', () => {
    it('appears in the Settings → Module writing styles list', async () => {
      render(<PromptStylesSection />);
      await flushAsyncUpdates(4);
      const row = await screen.findByTestId('prompt-style-row-freestyle');
      expect(within(row).getByText('Freestyle')).toBeTruthy();
      // Read-only like the others: ships in code, duplicated to be edited.
      expect(within(row).getByText('built-in')).toBeTruthy();
      // …and the list it comes from still carries Classic and Story.
      expect(screen.getByTestId('prompt-style-row-classic')).toBeTruthy();
      expect(screen.getByTestId('prompt-style-row-story')).toBeTruthy();
    });

    it('appears in the New Module dialog Writing style select', async () => {
      const user = userEvent.setup();
      const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
      render(
        <MemoryRouter>
          <NewModuleDialog campaign={campaign} open onOpenChange={() => undefined} />
        </MemoryRouter>,
      );
      const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
      await flushAsyncUpdates(4);

      await user.click(within(dialog).getByTestId('module-prompt-style'));
      const freestyle = await screen.findByRole(
        'option',
        { name: /Freestyle/ },
        { timeout: 5_000 },
      );
      expect(freestyle).toBeTruthy();
      // The select is the whole catalog, not a one-off addition.
      expect(screen.getByRole('option', { name: /Classic/ })).toBeTruthy();
      expect(screen.getByRole('option', { name: /Story/ })).toBeTruthy();

      // Choosing it is a real selection, not a decorative list entry: the closed
      // trigger carries the selected style. (Radix's `SelectValue` renders the
      // selected VALUE in this shadcn setup — the item's label is only in the
      // closed collection — so the pin is the changed selection itself, and
      // "Freestyle (built-in) — v1" is what the option offers.)
      await user.click(freestyle);
      await flushAsyncUpdates(4);
      expect(within(dialog).getByTestId('module-prompt-style').textContent).toContain('freestyle');
    }, 30_000);
  });
});

describe('remove-all-generated.test.tsx', () => {
  // The wipe aborts in-flight module passes first — that dynamic import must
  // never start real LLM machinery in this test.

  const toastSuccessMock = vi.mocked(toastSuccess);
  const toastErrorMock = vi.mocked(toastError);

  beforeEach(async () => {
    await clearDatabase();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  /**
   * Fresh-generation wipe UI (campaign settings surface): the Edit campaign
   * dialog carries the danger-zone action (never the tree or a high-traffic
   * spot); the two-step confirm lists live counts by kind + module/battle
   * counts; confirming wipes through the repo (PCs survive) and toasts what
   * was removed with counts. Failures surface via toastError, never a success
   * toast.
   */
  describe('EditCampaignDialog — remove all generated content', () => {
    async function seed(): Promise<Campaign> {
      const campaign = await createCampaign({ name: 'Wipe UI', system: 'dnd5e' });
      await createArtifact({ campaignId: campaign.id, kind: 'pc', name: 'Serren' });
      await createArtifact({ campaignId: campaign.id, kind: 'npc', name: 'Goblin' });
      const module = await createModule__2(
        buildModule({
          campaignId: campaign.id,
          title: 'Ember Vault',
          concept: '',
          levelMin: 1,
          levelMax: 3,
          sizeDial: 'sketch',
        }),
      );
      await createArtifact({
        campaignId: campaign.id,
        moduleId: module.id,
        kind: 'note',
        name: 'Module note',
      });
      return campaign;
    }

    function renderDialog(campaign: Campaign): void {
      // The dialog now navigates after destructive actions (clear-workspace
      // arc), so it needs router context even for the wipe-only tests.
      render(
        <MemoryRouter initialEntries={['/']}>
          <EditCampaignDialog campaign={campaign} open={true} onOpenChange={vi.fn()} />
        </MemoryRouter>,
      );
    }

    it('lists live counts in the confirm and wipes on confirm, keeping the Party', async () => {
      const user = userEvent.setup();
      const campaign = await seed();
      renderDialog(campaign);

      await user.click(await screen.findByTestId('remove-all-generated'));
      const confirm = await screen.findByTestId('remove-all-confirm-dialog');
      // Counts by kind + module count, with the Party-kept line.
      expect(await within(confirm).findByText(/2 artifacts \(1 note, 1 npc\)/)).toBeDefined();
      expect(within(confirm).getByText(/1 module/)).toBeDefined();
      expect(within(confirm).getByText(/1 PC.*stays untouched/)).toBeDefined();

      await user.click(within(confirm).getByTestId('remove-all-confirm'));

      // Destructive-confirm settle (docs/08 §Console guard): the wipe CLOSES the
      // AlertDialog and Base UI unmounts the popup on an exit timer
      // (AlertDialogRoot → DialogPortal → DialogBackdrop → DialogPopup updates).
      // Wait for that exit before the raw store reads below — a bare await with
      // the popup still closing hands those updates an outside-act window, the
      // act warning the console guard fails on (precedent: clear-workspace /
      // entity-panel's orphan-sweep dialog, 07a84bd).
      await waitFor(() => {
        expect(screen.queryByTestId('remove-all-confirm-dialog')).not.toBeInTheDocument();
      });

      await waitFor(() => {
        expect(toastSuccessMock).toHaveBeenCalledWith(
          expect.stringContaining('Removed 2 artifacts'),
        );
      });
      expect(toastErrorMock).not.toHaveBeenCalled();
      // The generated rows are gone; the Party row survives.
      await waitFor(async () => {
        expect(await db.artifacts.where('campaignId').equals(campaign.id).count()).toBe(1);
      });
      // actDrained on the raw reads (docs/08 §Console guard): the wipe's commit
      // re-fires the panel's live queries, and the bare await re-opens the same
      // outside-act window the closing dialog's timers ride.
      const survivors = await actDrained(() =>
        db.artifacts.where('campaignId').equals(campaign.id).toArray(),
      );
      expect(survivors.map((row) => row.kind)).toEqual(['pc']);
      expect(await actDrained(() => getArtifact(survivors[0]?.id ?? ''))).toBeDefined();
      expect(
        await actDrained(() => db.modules.where('campaignId').equals(campaign.id).count()),
      ).toBe(0);
    });

    it('says so when there is nothing generated to remove', async () => {
      const user = userEvent.setup();
      const campaign = await createCampaign({ name: 'Bare', system: 'dnd5e' });
      renderDialog(campaign);

      await user.click(await screen.findByTestId('remove-all-generated'));
      const confirm = await screen.findByTestId('remove-all-confirm-dialog');
      expect(await within(confirm).findByText(/no generated content/)).toBeDefined();
    });
  });
});

describe('prompt-style-default-ui.test.tsx', () => {
  /**
   * The New Module dialog's Writing style select under the NEW product default
   * (docs/17 row 88): a fresh app preselects Freestyle, and an explicitly STORED
   * default is honored and shown instead.
   *
   * The select is data-driven — it reads `readPromptStyleCatalog`, which carries
   * the settings row's `defaultPromptStyleId` — so these pins are about the value
   * the two surfaces actually resolve, not about a hand-added option.
   *
   * Freestyle's PRESENCE in the list is the row-87 arc's pin
   * (`prompt-style-freestyle-ui.test.tsx`); nothing here duplicates it. The
   * stored-draft semantics (the choice, the app default resolved at creation, the
   * prefill) belong to `new-module-draft.test.tsx`.
   */

  // Creation must never start real LLM machinery here.

  /**
   * The select's closed trigger: the shadcn implementation renders the selected
   * VALUE plus a chevron, so the pin is containment on the id — an exact string
   * would be pinned to the trigger's chrome.
   */
  function selectedStyleTrigger(dialog: HTMLElement): string {
    return within(dialog).getByTestId('module-prompt-style').textContent;
  }

  /** One dialog open against a fresh campaign, with the catalog read settled. */
  async function openDialog(): Promise<HTMLElement> {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    render(
      <MemoryRouter>
        <NewModuleDialog campaign={campaign} open onOpenChange={() => undefined} />
      </MemoryRouter>,
    );
    const dialog = await screen.findByTestId('new-module-dialog', {}, { timeout: 5_000 });
    await flushAsyncUpdates(4);
    return dialog;
  }

  beforeEach(async () => {
    await db.open();
    await clearDatabase();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('the Writing style select under the Freestyle product default', () => {
    it('preselects Freestyle for a fresh app', async () => {
      const dialog = await openDialog();
      // REVERT-PROOF: with the product default back at Classic (or with the
      // dialog's own fallback on Classic) this shows "classic".
      expect(selectedStyleTrigger(dialog)).toContain('freestyle');
      expect(selectedStyleTrigger(dialog)).not.toContain('classic');
      // …and the option really is the built-in Freestyle, not an id that happens
      // to resolve to nothing.
      await userEvent.setup().click(within(dialog).getByTestId('module-prompt-style'));
      const freestyle = await screen.findByRole(
        'option',
        { name: /Freestyle/ },
        { timeout: 5_000 },
      );
      expect(freestyle).toBeTruthy();
    }, 30_000);

    it('preselects an EXPLICITLY STORED non-Freestyle default instead', async () => {
      // A stored value is data and is honored: nothing rewrites it to the product
      // default, and the dialog shows what the app will use.
      await updateSettings({ defaultPromptStyleId: 'story' });
      const dialog = await openDialog();
      expect(selectedStyleTrigger(dialog)).toContain('story');
      expect(selectedStyleTrigger(dialog)).not.toContain('freestyle');
    }, 30_000);

    it('a stored default pointing at a style that no longer exists is named, never silently swapped', async () => {
      // The product default must not become a hiding place for a broken stored
      // value: an id that resolves to nothing is reported in the dialog (AGENTS 1).
      await updateSettings({ defaultPromptStyleId: 'freestyle' });
      await db.settings.put({
        ...(await db.settings.get('settings')),
        defaultPromptStyleId: 'no-such-style',
      } as unknown as Parameters<typeof db.settings.put>[0]);
      const dialog = await openDialog();
      expect(within(dialog).getByTestId('module-prompt-style-missing').textContent).toContain(
        'no-such-style',
      );
    }, 30_000);
  });
});

describe('cover-art.test.tsx', () => {
  /**
   * Cover art displays (cover-generation arc): every surface mounts its slot
   * through `useImageUrl(coverImageId)` — thumb (list), hero (reader), card
   * art (picker) — with the Generate affordance beside it. Cover-less rows
   * mount no art and keep their shape.
   */

  // The router graph pulls the module generator; generation never runs here.

  function renderAppAt(path: string): void {
    window.history.replaceState(null, '', path);
    render(<RouterProvider router={createAppRouter()} />);
  }

  function renderPicker(): void {
    render(
      <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
        <Routes>
          <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
          <Route path="*" element={<div data-testid="navigated-away" />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(async () => {
    // jsdom lacks object URL support; the hooks revoke what they create.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock-cover'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    await clearDatabase();
    await seedBuiltInPersonas();
  });

  afterEach(cleanup);

  async function seedCampaignWithCover(name: string): Promise<Id> {
    const campaign = await createCampaign({ name, description: 'A city of ash.', system: 'dnd5e' });
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['campaign-art'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 64,
      height: 64,
      prompt: '',
      model: '',
      source: 'generated',
    });
    await updateCampaign(campaign.id, { coverImageId: image.id });
    return campaign.id;
  }

  async function seedModuleWithCover(campaignId: Id, title: string): Promise<Id> {
    const module = await saveModuleRow(
      createModule({
        campaignId,
        title,
        concept: 'A whispering vault.',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
      }),
    );
    const image = await createImage({
      campaignId,
      blob: new Blob(['module-art'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 64,
      height: 64,
      prompt: '',
      model: '',
      source: 'generated',
    });
    await patchModule(module.id, { coverImageId: image.id });
    return module.id;
  }

  describe('cover art displays', () => {
    it('the module list row mounts the thumb with the generate affordance', async () => {
      const campaignId = await seedCampaignWithCover('Ember');
      await seedModuleWithCover(campaignId, 'Vault of Whispers');
      renderAppAt(modulesPath(campaignId));

      expect(await screen.findByTestId('module-cover-thumb')).toHaveAttribute(
        'src',
        'blob:mock-cover',
      );
      expect(screen.getByAltText('Cover art for Vault of Whispers')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Regenerate cover for Vault of Whispers' }),
      ).toBeInTheDocument();
    });

    it('a cover-less module row mounts no thumb but keeps its generate affordance', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      await saveModuleRow(
        createModule({
          campaignId: campaign.id,
          title: 'Bare Module',
          concept: 'Nothing yet.',
          levelMin: 1,
          levelMax: 1,
          sizeDial: 'sketch',
        }),
      );
      renderAppAt(modulesPath(campaign.id));

      expect(await screen.findByText('Bare Module')).toBeInTheDocument();
      expect(screen.queryByTestId('module-cover-thumb')).not.toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Generate cover for Bare Module' }),
      ).toBeInTheDocument();
    });

    it('the reader header mounts the hero with the generate affordance', async () => {
      const campaignId = await seedCampaignWithCover('Ember');
      const moduleId = await seedModuleWithCover(campaignId, 'Vault of Whispers');
      renderAppAt(modulePath(campaignId, moduleId));

      expect(await screen.findByTestId('module-cover-hero')).toHaveAttribute(
        'src',
        'blob:mock-cover',
      );
      expect(
        screen.getByRole('button', { name: 'Regenerate cover for Vault of Whispers' }),
      ).toBeInTheDocument();
    });

    it('the campaign picker card mounts the art with the generate affordance', async () => {
      await seedCampaignWithCover('Ember');
      renderPicker();

      expect(await screen.findByTestId('campaign-cover-art')).toHaveAttribute(
        'src',
        'blob:mock-cover',
      );
      expect(screen.getByAltText('Cover art for Ember')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Regenerate cover for Ember' }),
      ).toBeInTheDocument();
    });
  });
});
