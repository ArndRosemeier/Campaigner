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
 *   - tests/features/modules-list.test.tsx (15) — now
 *     `campaign-document-landing.test.tsx`: the module LIST is DELETED
 *     (docs/17 row 389), so the same backgrounds pin the campaign's ONE
 *     document, its create state, the moved delete dialog and the legacy
 *     multi-module notice instead
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
import { documentPath, modulePath, ROUTES } from '@/app/routes';
import { createArtifact, getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign, updateCampaign } from '@/db/campaignRepo';
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
  encounterDataSchema,
  modulePartSchema,
  moduleSpineSchema,
  createModule as buildModule,
} from '@/domain';
import type { Id, Module, Campaign } from '@/domain';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { repoFiles } from '../helpers/sourceCode';
import { readFileSync } from 'node:fs';
import { EntityPanel } from '@/features/modules/entity-panel';
import { NORMALIZATION_FAILURE_MESSAGE } from '@/llm/moduleGen';
import { db } from '@/db/db';
import { PromptStylesSection } from '@/features/settings/prompt-styles-section';
import { EditCampaignDialog } from '@/features/campaign/components/edit-campaign-dialog';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { createImage } from '@/db/imageRepo';

const { normalizeModuleEntityNames } = await import('@/llm/moduleGen');
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
    runParts: vi.fn(),
    cancelModuleGen: vi.fn(),
    generateMissingParts: vi.fn(),
    rewritePart: vi.fn(),
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

describe('campaign-document-landing.test.tsx', () => {
  /**
   * THE CAMPAIGN'S ONE DOCUMENT (docs/23 §10 phase 2, docs/17 row 389). This
   * describe was `modules-list.test.tsx`, whose surface — the module LIST page
   * — is DELETED: a campaign owns exactly ONE module row, so the campaign
   * route lands on that document's reader (whose ToC is the level list), or
   * shows the create state when the campaign has no row yet. The list row's
   * own controls moved: the delete dialog now lives on the reader
   * (`module-delete-dialog`), and creation lives on the landing's create
   * state. A legacy campaign that still carries SEVERAL module rows is
   * surfaced by the campaign bar's `LegacyModulesNotice` — never hidden.
   */

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

  describe('the campaign leads to its ONE document', () => {
    it('the document route lands on the campaign document — no module list in between', async () => {
      const { campaignId, draftId } = await seedModules();
      renderAppAt(documentPath(campaignId));

      // The ONE document (arc-first = 'Vault of Whispers', levelMin 1) is
      // reached directly; the deleted list page never renders.
      await screen.findByTestId('module-reader', {}, { timeout: 10_000 });
      expect(window.location.pathname).toBe(modulePath(campaignId, draftId));
      expect(screen.queryByTestId('modules-page')).not.toBeInTheDocument();
      // The reader's ToC IS the derived level list (§4): levels 1..3.
      expect(await screen.findByText('The Mill', {}, { timeout: 10_000 })).toBeInTheDocument();
      expect(screen.getByText('The Vault')).toBeInTheDocument();
      await flushAsyncUpdates();
    }, 20_000);

    it('reads the documents in ARC order — the landing picks the start-level-first row', async () => {
      // THE RECENCY ORDER CONTRADICTS THE LEVEL ORDER ON PURPOSE: the level-5
      // chapter was edited last and the level-1 chapter first. The landing must
      // still pick the ARC-FIRST row as THE document.
      await seedBuiltInPersonas();
      const campaign = await createCampaign({ name: 'The Arc', system: 'dnd5e' });
      const anchor = Date.now();
      const seedChapter = async (
        title: string,
        levelMin: number,
        levelMax: number,
        updatedAt: number,
      ): Promise<Module> => {
        const saved = await saveModule(
          buildModule({
            campaignId: campaign.id,
            title,
            concept: '',
            levelMin,
            levelMax,
            sizeDial: 'sketch',
          }),
        );
        await db.modules.update(saved.id, { updatedAt });
        return saved;
      };
      const later = await seedChapter('The Later Chapter', 5, 6, anchor + 3000);
      const middle = await seedChapter('The Middle Chapter', 3, 4, anchor + 2000);
      const early = await seedChapter('The Early Chapter', 1, 2, anchor + 1000);

      renderAppAt(documentPath(campaign.id));
      await screen.findByTestId('module-reader', {}, { timeout: 10_000 });

      // The ARC-FIRST chapter is the document, and it is REACHABLE despite the
      // recency order — a page still reading the repo's "newest first" order
      // would have landed on `later`.
      expect(window.location.pathname).toBe(modulePath(campaign.id, early.id));

      // The extras are NAMED and LINKED, in the same arc order (docs/17 row
      // 389): never silently hidden.
      const notice = await screen.findByTestId('legacy-extra-modules', {}, { timeout: 10_000 });
      expect(notice).toHaveTextContent('3 module rows');
      expect(notice).toHaveTextContent('The Early Chapter');
      expect(notice).toHaveTextContent('The Middle Chapter');
      expect(notice).toHaveTextContent('The Later Chapter');
      expect(within(notice).getByTestId(`legacy-extra-module-${middle.id}`)).toHaveAttribute(
        'href',
        modulePath(campaign.id, middle.id),
      );
      expect(within(notice).getByTestId(`legacy-extra-module-${later.id}`)).toHaveAttribute(
        'href',
        modulePath(campaign.id, later.id),
      );
      await flushAsyncUpdates();
    }, 20_000);

    it('the legacy notice names every extra row on the reader too, and stays silent for ONE row', async () => {
      const { campaignId, draftId, failedId } = await seedModules();
      renderAppAt(modulePath(campaignId, draftId));
      await screen.findByTestId('module-reader', {}, { timeout: 10_000 });

      const notice = await screen.findByTestId('legacy-extra-modules', {}, { timeout: 10_000 });
      expect(notice).toHaveTextContent('2 module rows');
      expect(notice).toHaveTextContent('Sunken Cult');
      expect(within(notice).getByTestId(`legacy-extra-module-${failedId}`)).toHaveAttribute(
        'href',
        modulePath(campaignId, failedId),
      );
      await flushAsyncUpdates();
    }, 20_000);

    it('renders NO legacy notice for the ratified one-document shape', async () => {
      await seedBuiltInPersonas();
      const campaign = await createCampaign({ name: 'Single', system: 'dnd5e' });
      await saveModule(
        buildModule({
          campaignId: campaign.id,
          title: 'The Only Chapter',
          concept: '',
          levelMin: 1,
          levelMax: 1,
          sizeDial: 'sketch',
        }),
      );
      renderAppAt(documentPath(campaign.id));
      await screen.findByTestId('module-reader', {}, { timeout: 10_000 });
      expect(screen.queryByTestId('legacy-extra-modules')).not.toBeInTheDocument();
      await flushAsyncUpdates();
    }, 20_000);
  });

  describe('the document delete dialog (moved from the list row to the reader)', () => {
    it('deletes a module after confirmation and removes the row from the DB', async () => {
      const user = userEvent.setup();
      const { campaignId, failedId } = await seedModules();
      renderAppAt(modulePath(campaignId, failedId));
      await screen.findByTestId('delete-module', {}, { timeout: 10_000 });

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
      // The deleted extra row is gone from the legacy notice, and the campaign
      // route now reaches the surviving document.
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
      renderAppAt(modulePath(campaignId, failedId));
      await screen.findByTestId('delete-module', {}, { timeout: 10_000 });

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
          levelHint: '', partyLevel: 3,
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
      renderAppAt(modulePath(campaignId, draftId));
      await screen.findByTestId('delete-module', {}, { timeout: 10_000 });

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
      // The read is act-wrapped: the open dialog's OWN live scans (owned
      // count, cited creatures, outside references) settle while it is
      // mounted, and a bare await would let one land outside act (docs/08
      // §Console guard).
      const after = await actDrained(() => listArtifactsByCampaign(campaignId));
      expect(after).toHaveLength(before.length + 1);
      expect(after.some((row) => row.kind === 'npc')).toBe(false);
      // Close the dialog inside the test: it is MOUNTED only while open, so
      // its live scans unmount here rather than settling after the test.
      await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => {
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      });
      await flushAsyncUpdates();
    }, 20_000);

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
      renderAppAt(modulePath(campaignId, draftId));
      await screen.findByTestId('delete-module', {}, { timeout: 10_000 });

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
      renderAppAt(modulePath(campaignId, draftId));
      await screen.findByTestId('delete-module', {}, { timeout: 10_000 });

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
      const files = repoFiles('src', ['.ts', '.tsx']);
      // Non-vacuity: this really walked the source tree, so the scan below can
      // only pass because it read files at all.
      expect(files.length).toBeGreaterThan(50);

      const stated = files.filter((file) => readFileSync(file, 'utf8').includes(SENTENCE));
      // A fourth copy of the wording anywhere in the app fails this — the shape
      // that drifted into a missing cancel guard once already.
      expect(stated).toEqual(['src/llm/moduleGen.ts']);

      // The two surfaces that must keep saying it reach it through the export:
      // the panel's belt, and the pass's own recording seam.
      const panel = readFileSync('src/features/modules/entity-panel.tsx', 'utf8');
      expect(panel).toContain('NORMALIZATION_FAILURE_MESSAGE');
      expect(panel).not.toContain(SENTENCE);
      const gen = readFileSync('src/llm/moduleGen.ts', 'utf8');
      // Exactly one statement of the sentence inside the seam…
      expect(gen.split(SENTENCE)).toHaveLength(2);
      // …and FIVE catches that go through the seam instead of restating it: the
      // post-parts pass, the re-normalization after a floor repair, the repair
      // pass, the full pass's own catch and the incremental classification's.
      expect(gen.match(/recordNormalizationFailure\(error\)/g)).toHaveLength(5);
    }, 20000);
  });
});

describe('prompt-style-freestyle-ui.test.tsx', () => {
  /**
   * Freestyle is SELECTABLE in the Settings writing-style list
   * (docs/17 row 87).
   *
   * The list is data-driven — `PromptStylesSection` maps `BUILTIN_PROMPT_STYLES`
   * plus the user's own — so this pin is about the DATA reaching the list a
   * user actually picks from. REVERT-PROOF: removing the freestyle entry from
   * `BUILTIN_PROMPT_STYLES` makes it fail. (MIGRATED, docs/17 row 395: the
   * creation dialog's own Writing-style select — the second surface — is
   * DELETED with the dialog, so its pins are deleted, not weakened.)
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
    it('the campaign document route reaches the reader, which mounts the hero with the generate affordance', async () => {
      const campaignId = await seedCampaignWithCover('Ember');
      await seedModuleWithCover(campaignId, 'Vault of Whispers');
      renderAppAt(documentPath(campaignId));

      // The landing resolves the campaign's ONE document (no list in between):
      // the reader's cover hero carries the art and the affordance.
      expect(await screen.findByTestId('module-cover-hero')).toHaveAttribute(
        'src',
        'blob:mock-cover',
      );
      expect(screen.queryByTestId('module-cover-thumb')).not.toBeInTheDocument();
      expect(screen.getByAltText('Cover art for Vault of Whispers')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Regenerate cover for Vault of Whispers' }),
      ).toBeInTheDocument();
    });

    it('a cover-less document mounts no thumb but keeps its generate affordance', async () => {
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
      renderAppAt(documentPath(campaign.id));

      expect(await screen.findByTestId('module-reader')).toBeInTheDocument();
      expect(screen.queryByTestId('module-cover-thumb')).not.toBeInTheDocument();
      expect(screen.queryByTestId('module-cover-hero')).not.toBeInTheDocument();
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
