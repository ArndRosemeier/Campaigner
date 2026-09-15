/**
 * MERGED same-background cluster (docs/17 row 177, extending row 176's pilot):
 * five `tests/features` files with NO `vi.mock` at all that share ONE
 * background — fake-indexeddb + `clearDatabase()` per test + the
 * `../helpers/flush` act drain, mounting whole routed surfaces (the app router,
 * the guide, the onboarding wizard, the artifact editor) — now run in ONE file,
 * so the import/transform/jsdom-environment/setup cost is paid once instead of
 * five times. They already imported both `../db/helpers` and `../helpers/flush`;
 * sharing one module registry is safe precisely because none of them mocks
 * (docs/17 row 175).
 *
 * Merged from (one `describe` per original file, so each stays findable; test
 * names and every `expect` assertion site is byte-identical):
 *   - tests/features/app-shell-boot-reconcile.test.tsx (4)
 *   - tests/features/editor-run-battle.test.tsx (9)
 *   - tests/features/editor-surfaces.test.tsx (12)
 *   - tests/features/guide.test.tsx (10)
 *   - tests/features/onboarding-wizard.test.tsx (13)
 *
 * `tests/features/module-board.test.tsx` is deliberately NOT merged: it mutates
 * process-wide globals by direct assignment in `beforeEach`
 * (`globalThis.DOMMatrixReadOnly`, `globalThis.ResizeObserver`,
 * `HTMLElement.prototype.offsetWidth/clientHeight`,
 * `Element.prototype.getBoundingClientRect`) that `vi.restoreAllMocks()` cannot
 * undo, and it is a React-Flow `board*` act-heavy surface — the two stop
 * conditions in the sweep rule. It stays a file of its own.
 */

import 'fake-indexeddb/auto';
import { render, screen, waitFor, cleanup, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '@/app/router';
import {
  ROUTES,
  modulePath,
  battlePath,
  guidePath,
  modulesPath,
  workspacePath,
} from '@/app/routes';
import { DEFAULT_THEME, useThemeStore } from '@/app/theme/theme';
import { createCampaign } from '@/db/campaignRepo';
import { listPersonas } from '@/db/personaRepo';
import { createRun, getRun } from '@/db/runRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  defaultSettings,
  modulePartSchema,
  moduleSpineSchema,
  createModule,
  blankStatBlock,
} from '@/domain';
import type {
  Artifact,
  Id,
  Module,
  ArtifactLink,
  EncounterArtifactData,
  StatBlock,
  OnboardingStepId,
} from '@/domain';
import { saveSettings, readSettings } from '@/db/settingsRepo';
import { INTERRUPTED_MODULE_GEN_MESSAGE } from '@/llm/moduleGenReconcile';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { createArtifact, getArtifact, listRevisions, updateArtifact } from '@/db/artifactRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { getBattleByModule, saveBattleBoard } from '@/db/battleRepo';
import { db } from '@/db/db';
import { ArtifactEditor } from '@/features/campaign/components/artifact-editor';
import { expectBlockedReason } from '../helpers/blocked-reason';
import { GUIDE_CHAPTERS } from '@/features/guide/guideContent';
import { useOnboardingStore } from '@/features/onboarding/onboardingStore';
import { useHelpStore } from '@/help/helpStore';

describe('app-shell-boot-reconcile.test.tsx', () => {
  /**
   * WHAT THE SHELL OWNS AT START (docs/17 row 110, docs/18 §2.2/§4).
   *
   * Two measured defects lived in `AppShell`:
   *
   * 1. `failRunningRuns()`, `seedBuiltInPersonas()` and `ensurePersistentStorage()`
   *    were called from the RENDER BODY. Every re-render (the theme toggle, the
   *    help dialog, any store change) re-ran them — and `failRunningRuns` marks
   *    every `status: 'running'` row failed, so a live run could be failed by an
   *    unrelated UI change. It is a START action; it now runs in a mount effect.
   * 2. Nothing reconciled MODULE rows, so a tab that was reloaded/discarded mid
   *    generation left a module 'generating' forever: a permanent spinner, a Stop
   *    button that did nothing, every retry affordance gated behind `!busy`, and
   *    "Stop all" counting it as stopped. Start now reconciles those rows loudly.
   *
   * The reload cases that make this matter most get NO `visibilitychange` at all
   * (a discarded tab reloads), which is why start is the load-bearing moment and
   * the visibility path is only the second chance.
   */

  async function seedSettledOnboarding(): Promise<void> {
    await saveSettings({
      ...defaultSettings(),
      onboarding: { status: 'complete' as const, stepState: [] },
    });
  }

  function renderAppAt(path: string): void {
    window.history.replaceState(null, '', path);
    render(<RouterProvider router={createAppRouter()} />);
  }

  async function seedRunningRun(): Promise<string> {
    const campaign = await createCampaign({ name: 'Boot', system: 'dnd5e' });
    const persona = (await listPersonas())[0];
    if (persona === undefined) throw new Error('no built-in persona seeded');
    const run = await createRun({
      campaignId: campaign.id,
      personaId: persona.id,
      autonomy: 'auto',
      userBrief: 'Detail the gate warden',
    });
    return run.id;
  }

  /** A module row in exactly the state a reloaded tab leaves behind. */
  async function seedInterruptedModule(): Promise<{ campaignId: string; moduleId: string }> {
    const campaign = await createCampaign({ name: 'Interrupted', system: 'dnd5e' });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'The Drowned Vault',
      concept: 'A vault under the mill.',
      levelMin: 1,
      levelMax: 2,
      tone: '',
      sizeDial: 'sketch',
    });
    const saved = await saveModule({
      ...draft,
      status: 'generating',
      spine: moduleSpineSchema.parse({
        premise: 'The premise promises a drowned [[Vault Door]].',
        themes: [],
        partPlan: [{ title: 'The Mill', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: '',
          status: 'generating',
          errorMessage: '',
          edited: false,
        }),
      ],
    });
    return { campaignId: campaign.id, moduleId: saved.id };
  }

  beforeEach(async () => {
    useThemeStore.setState({ theme: DEFAULT_THEME });
    await clearDatabase();
    await seedBuiltInPersonas();
    await seedSettledOnboarding();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('app shell: start-time reconciliation is a mount effect, never a render', () => {
    it('does not fail a live run when the shell re-renders', async () => {
      const user = userEvent.setup();
      renderAppAt(ROUTES.campaignPicker);
      // The mount reconcile has run (and found nothing): from here on, a run that
      // starts in this page is LIVE work, not a leftover from a previous page.
      await screen.findByRole('link', { name: 'Campaigner' });
      const runId = await actDrained(() => seedRunningRun());

      // Two unrelated re-renders of the shell (the theme toggle is a store write,
      // which is all any of them are).
      await user.click(await screen.findByRole('button', { name: 'Switch to light theme' }));
      await user.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));
      await flushAsyncUpdates();

      expect(useThemeStore.getState().theme).toBe('dark');
      // The live run is untouched: only APP START may reconcile.
      const live = await actDrained(() => getRun(runId));
      expect(live?.status).toBe('running');
      expect(live?.errorMessage).toBe('');
    }, 20_000);

    it("still fails a run a previous page left 'running' — loudly, at start", async () => {
      const runId = await seedRunningRun();

      renderAppAt(ROUTES.campaignPicker);

      await waitFor(async () => {
        const run = await getRun(runId);
        expect(run?.status).toBe('failed');
        expect(run?.errorMessage).toBe('Interrupted by reload');
        expect(run?.failureKind).toBe('cancelled');
      });
      await flushAsyncUpdates();
    }, 20_000);

    it("reconciles a module a reloaded tab left 'generating', and the reader's recovery control works", async () => {
      const { campaignId, moduleId } = await seedInterruptedModule();

      renderAppAt(modulePath(campaignId, moduleId));

      // The owner-visible outcome, on the reader he was staring at: a named
      // failure — never a spinner that stays forever.
      const banner = await screen.findByTestId('module-failed-banner', {}, { timeout: 10_000 });
      expect(banner).toHaveTextContent('Module generation encountered an error.');
      expect(banner).toHaveTextContent(/the page that was writing it is gone/u);
      // …and the recovery the message names is on screen and ENABLED (before the
      // fix every one of these was gated behind `!busy`) — as is the Stop control,
      // which now has nothing left to stop and is gone rather than a no-op.
      expect(await screen.findByTestId('resume-module-generation')).toBeEnabled();
      expect(screen.queryByTestId('module-stop')).not.toBeInTheDocument();
      expect(screen.getByTestId('generate-missing')).toBeEnabled();

      const row = await actDrained(() => getModule(moduleId));
      expect(row?.status).toBe('failed');
      expect(row?.errorMessage).toBe(INTERRUPTED_MODULE_GEN_MESSAGE);
      // The unfinished part slot rewound, which is what makes the resume path
      // write exactly the parts that were lost.
      expect(row?.parts[0]?.status).toBe('pending');
    }, 20_000);

    it('leaves a module alone when a live pass owns it (the same guard, through the UI)', async () => {
      const { campaignId, moduleId } = await seedInterruptedModule();
      // A live forge in THIS page is the page-local registry the guard reads; the
      // engine itself is exercised in tests/llm/moduleGenReconcile.test.ts.
      const moduleGen = await import('@/llm/moduleGen');
      const spy = vi.spyOn(moduleGen, 'hasLiveModuleGen').mockReturnValue(true);

      renderAppAt(modulePath(campaignId, moduleId));
      await screen
        .findByTestId('module-failed-banner', {}, { timeout: 10_000 })
        .catch(() => undefined);

      expect((await actDrained(() => getModule(moduleId)))?.status).toBe('generating');
      expect(spy).toHaveBeenCalled();
      await flushAsyncUpdates();
    }, 20_000);
  });
});

describe('editor-run-battle.test.tsx', () => {
  /**
   * The editor's run-battle affordance (owner-ratified: own-module anchor +
   * picker fallback): module-scoped encounters run through the module view's
   * own RunBattleButton anchored to their own module; campaign-scoped ones
   * pick a module; zero modules is a named empty state; non-encounter kinds
   * stay untouched. Owner-ratified resume-by-default (encounter-resume arc): a
   * module already running THIS encounter offers "Open battle" — a plain
   * navigation that reattaches the persisted board — while a different
   * encounter keeps the two-step replace confirm. A successful seed navigates
   * straight to the seeded module's battle table.
   */

  /** Renders the current router location so tests can assert the navigation. */
  function LocationProbe() {
    const location = useLocation();
    return <span data-testid="route-location">{location.pathname}</span>;
  }

  async function seedWorld(moduleTitles: string[]): Promise<{
    campaignId: Id;
    encounter: Artifact;
    modules: Module[];
  }> {
    const campaign = await createCampaign({ name: 'Run editor', system: 'dnd5e' });
    const modules: Module[] = [];
    for (const title of moduleTitles) {
      modules.push(
        await saveModule(
          createModule({
            campaignId: campaign.id,
            title,
            concept: `Module ${title}.`,
            levelMin: 1,
            levelMax: 4,
            sizeDial: 'standard',
          }),
        ),
      );
    }
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Bridge Ambush',
    });
    return { campaignId: campaign.id, encounter, modules };
  }

  function requireModule(modules: Module[], index: number): Module {
    const module = modules[index];
    if (module === undefined) throw new Error(`Module ${index} missing`);
    return module;
  }

  function renderEditor(
    artifact: Artifact,
    campaignId: Id,
    campaignArtifacts: readonly Artifact[],
  ): void {
    render(
      <MemoryRouter>
        <ArtifactEditor
          artifact={artifact}
          campaignId={campaignId}
          campaignArtifacts={campaignArtifacts}
          campaignSystem="dnd5e"
        />
        <LocationProbe />
      </MemoryRouter>,
    );
  }

  beforeEach(clearDatabase);
  afterEach(cleanup);

  describe('artifact editor run battle', () => {
    it('shows Run battle for a module-owned encounter and seeds its own module', async () => {
      const user = userEvent.setup();
      const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt']);
      const crypt = requireModule(modules, 0);
      const owned = await createArtifact({
        campaignId,
        moduleId: crypt.id,
        kind: 'encounter',
        name: 'Crypt Gate',
      });
      renderEditor(owned, campaignId, [encounter, owned]);

      const button = screen.getByTestId('run-battle');
      expect(button).toHaveTextContent('Run battle');
      await user.click(button);
      await waitFor(async () => {
        const battle = await db.battles.where('moduleId').equals(crypt.id).first();
        expect(battle?.encounterArtifactId).toBe(owned.id);
      });
      expect(await db.battles.count()).toBe(1);
      // The seed lands the user on the module's battle table — no toast-estimated
      // detour telling them to open it themselves.
      await waitFor(() => {
        expect(screen.getByTestId('route-location')).toHaveTextContent(
          battlePath(campaignId, crypt.id),
        );
      });
      await flushAsyncUpdates();
    });

    it('same-encounter press resumes: Open battle navigates without replacing the board', async () => {
      const user = userEvent.setup();
      const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt']);
      const crypt = requireModule(modules, 0);
      const owned = await createArtifact({
        campaignId,
        moduleId: crypt.id,
        kind: 'encounter',
        name: 'Crypt Gate',
      });
      await seedBattleFromEncounter(campaignId, crypt.id, owned.id);
      // Drift the running board: a re-seed would reset activeIndex to 0 and
      // discard the stage — resume must keep it verbatim.
      const running = await getBattleByModule(crypt.id);
      if (running === undefined) throw new Error('running battle missing');
      await saveBattleBoard(running.id, { ...running.board, activeIndex: 2 });
      renderEditor(owned, campaignId, [encounter, owned]);

      await waitFor(() =>
        expect(screen.getByTestId('run-battle')).toHaveTextContent('Open battle'),
      );
      await user.click(screen.getByTestId('run-battle'));
      await waitFor(() => {
        expect(screen.getByTestId('route-location')).toHaveTextContent(
          battlePath(campaignId, crypt.id),
        );
      });
      const battle = await getBattleByModule(crypt.id);
      expect(battle?.encounterArtifactId).toBe(owned.id);
      // The drift survived — nothing was re-seeded.
      expect(battle?.board.activeIndex).toBe(2);
      await flushAsyncUpdates();
    });

    it('picker row for a module running this encounter offers Open battle and reattaches without a re-seed', async () => {
      const user = userEvent.setup();
      const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt']);
      const crypt = requireModule(modules, 0);
      await seedBattleFromEncounter(campaignId, crypt.id, encounter.id);
      const running = await getBattleByModule(crypt.id);
      if (running === undefined) throw new Error('running battle missing');
      await saveBattleBoard(running.id, { ...running.board, activeIndex: 1 });
      renderEditor(encounter, campaignId, [encounter]);

      await user.click(screen.getByTestId('run-battle-picker'));
      const row = await screen.findByTestId(`run-battle-module-${crypt.id}`);
      await waitFor(() => {
        expect(within(row).getByRole('button', { name: 'Open battle' })).toBeInTheDocument();
      });
      await user.click(within(row).getByRole('button', { name: 'Open battle' }));
      await waitFor(() => {
        expect(screen.queryByTestId('run-battle-module-picker')).toBeNull();
      });
      await waitFor(() => {
        expect(screen.getByTestId('route-location')).toHaveTextContent(
          battlePath(campaignId, crypt.id),
        );
      });
      const battle = await getBattleByModule(crypt.id);
      expect(battle?.encounterArtifactId).toBe(encounter.id);
      expect(battle?.board.activeIndex).toBe(1);
      await flushAsyncUpdates();
    });

    it('keeps the two-step replace confirm for the direct module-anchored path', async () => {
      const user = userEvent.setup();
      const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt']);
      const crypt = requireModule(modules, 0);
      const owned = await createArtifact({
        campaignId,
        moduleId: crypt.id,
        kind: 'encounter',
        name: 'Crypt Gate',
      });
      await seedBattleFromEncounter(campaignId, crypt.id, encounter.id);
      renderEditor(owned, campaignId, [encounter, owned]);
      await flushAsyncUpdates();

      await waitFor(() =>
        expect(screen.getByTestId('run-battle')).toHaveTextContent('Re-run battle'),
      );
      await user.click(screen.getByTestId('run-battle'));
      // Armed only — the running board is not replaced yet.
      expect(screen.getByTestId('run-battle')).toHaveTextContent('Replace running battle?');
      const before = await db.battles.where('moduleId').equals(crypt.id).first();
      expect(before?.encounterArtifactId).toBe(encounter.id);

      await user.click(screen.getByTestId('run-battle'));
      await waitFor(async () => {
        const battle = await db.battles.where('moduleId').equals(crypt.id).first();
        expect(battle?.encounterArtifactId).toBe(owned.id);
      });
      await flushAsyncUpdates();
    });

    it('campaign-scoped encounter opens the module picker and seeds the picked module', async () => {
      const user = userEvent.setup();
      const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt', 'Tide Bell']);
      const tide = requireModule(modules, 1);
      renderEditor(encounter, campaignId, [encounter]);

      await user.click(screen.getByTestId('run-battle-picker'));
      expect(await screen.findByTestId('run-battle-module-picker')).toBeInTheDocument();
      expect(screen.getByText('Ember Crypt')).toBeInTheDocument();
      expect(screen.getByText('Tide Bell')).toBeInTheDocument();

      const tideRow = screen.getByTestId(`run-battle-module-${tide.id}`);
      expect(tideRow).toHaveTextContent('0 artifacts');
      await user.click(within(tideRow).getByRole('button', { name: 'Run battle' }));
      await waitFor(async () => {
        const battle = await db.battles.where('moduleId').equals(tide.id).first();
        expect(battle?.encounterArtifactId).toBe(encounter.id);
      });
      // The dialog closes once the seed landed.
      await waitFor(() => {
        expect(screen.queryByTestId('run-battle-module-picker')).toBeNull();
      });
      // And the picked module's battle table is where the user ends up.
      await waitFor(() => {
        expect(screen.getByTestId('route-location')).toHaveTextContent(
          battlePath(campaignId, tide.id),
        );
      });
      await flushAsyncUpdates();
    });

    it('picker path asks before replacing a picked module’s running battle', async () => {
      const user = userEvent.setup();
      const { campaignId, encounter, modules } = await seedWorld(['Ember Crypt', 'Tide Bell']);
      const tide = requireModule(modules, 1);
      const other = await createArtifact({
        campaignId,
        kind: 'encounter',
        name: 'Crypt Gate',
      });
      await seedBattleFromEncounter(campaignId, tide.id, other.id);
      renderEditor(encounter, campaignId, [encounter, other]);

      await user.click(screen.getByTestId('run-battle-picker'));
      const tideRow = () => screen.getByTestId(`run-battle-module-${tide.id}`);
      await user.click(
        within(await screen.findByTestId(`run-battle-module-${tide.id}`)).getByRole('button', {
          name: 'Re-run battle',
        }),
      );
      // Armed only — the running board is not replaced yet.
      expect(
        within(tideRow()).getByRole('button', { name: 'Replace running battle?' }),
      ).toBeInTheDocument();
      const before = await db.battles.where('moduleId').equals(tide.id).first();
      expect(before?.encounterArtifactId).toBe(other.id);

      await user.click(within(tideRow()).getByRole('button', { name: 'Replace running battle?' }));
      await waitFor(async () => {
        const battle = await db.battles.where('moduleId').equals(tide.id).first();
        expect(battle?.encounterArtifactId).toBe(encounter.id);
      });
      await waitFor(() => {
        expect(screen.queryByTestId('run-battle-module-picker')).toBeNull();
      });
      await flushAsyncUpdates();
    });

    it('picker rows are arrow-key navigable', async () => {
      const user = userEvent.setup();
      const { campaignId, encounter } = await seedWorld(['Ember Crypt', 'Tide Bell']);
      renderEditor(encounter, campaignId, [encounter]);

      await user.click(screen.getByTestId('run-battle-picker'));
      const list = await screen.findByTestId('run-battle-module-list');
      // Row order is the live query's (updatedAt desc) — derive it from the DOM.
      const rowTestIds = Array.from(
        list.querySelectorAll<HTMLElement>('[data-testid^="run-battle-module-"]'),
      ).map((row) => row.getAttribute('data-testid'));
      const firstRowId = rowTestIds[0];
      const secondRowId = rowTestIds[1];
      if (
        firstRowId === undefined ||
        firstRowId === null ||
        secondRowId === undefined ||
        secondRowId === null
      ) {
        throw new Error('rows missing');
      }

      const focusRowButton = (rowTestId: string): void => {
        within(screen.getByTestId(rowTestId)).getByRole('button', { name: 'Run battle' }).focus();
      };
      const focusedRowId = (): string | null | undefined =>
        (document.activeElement as HTMLElement)
          .closest('[data-testid^="run-battle-module-"]')
          ?.getAttribute('data-testid');

      focusRowButton(firstRowId);
      await user.keyboard('{ArrowDown}');
      expect(focusedRowId()).toBe(secondRowId);
      await user.keyboard('{ArrowUp}');
      expect(focusedRowId()).toBe(firstRowId);
      await flushAsyncUpdates();
    });

    it('picker shows a named empty state when the campaign has no modules', async () => {
      const user = userEvent.setup();
      const { campaignId, encounter } = await seedWorld([]);
      renderEditor(encounter, campaignId, [encounter]);

      await user.click(screen.getByTestId('run-battle-picker'));
      const empty = await screen.findByTestId('run-battle-picker-empty');
      expect(empty).toHaveTextContent('No modules in this campaign yet.');
      expect(empty).toHaveTextContent('Battles anchor to modules');
      expect(screen.queryByTestId('run-battle-module-list')).toBeNull();
      await flushAsyncUpdates();
    });

    it('non-encounter kinds show no run affordance', async () => {
      const { campaignId, encounter } = await seedWorld(['Ember Crypt']);
      const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Mira' });
      renderEditor(npc, campaignId, [encounter, npc]);

      expect(screen.queryByTestId('run-battle')).toBeNull();
      expect(screen.queryByTestId('run-battle-picker')).toBeNull();
      await flushAsyncUpdates();
    });
  });
});

describe('editor-surfaces.test.tsx', () => {
  /**
   * Editor sub-surfaces that no dedicated test interacted with (08-TESTING
   * matrix): markdown preview toggle, tag editor, links section, stat block
   * card/form toggle, and the revision dropdown → snapshot → restore flow.
   */

  const NPC_DATA = {
    appearance: 'Small, soot-stained.',
    personality: 'Manic, cheerful.',
    statBlock: null,
  };

  /**
   * The ONE complex-encounter fixture the two Repopulate-copy pins read (AGENTS
   * rule 4): they differ ONLY in the layout — a two-room dungeon the control can
   * repopulate, or `null` (roomless: it is held). `EncounterArtifactData` is
   * annotated here because an inline literal against the artifact-data union
   * narrows its members to `never`.
   */
  function complexEncounterData(layout: EncounterArtifactData['layout']): EncounterArtifactData {
    return {
      difficulty: 'old',
      levelHint: '4',
      monsters: [],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: null,
      preset: 'standard',
      locationKind: 'dungeon',
      siteShape: 'complex',
      budgetAdvisory: '',
      layout,
    };
  }

  /** Two rooms (a complex needs more than one, `encounterDataSchema`): stocked. */
  const STOCKED_COMPLEX_LAYOUT: EncounterArtifactData['layout'] = {
    gridW: 24,
    gridH: 18,
    theme: 'undercroft',
    rooms: [
      {
        id: '00000000-0000-4000-8000-0000000000e1',
        name: 'A',
        rects: [{ x: 1, y: 1, w: 6, h: 6 }],
        mobsRect: { x: 2, y: 2, w: 4, h: 4 },
        description: '',
        monsterIndexes: [],
        spawn: true,
        key: '',
        keyTreasure: '',
      },
      {
        id: '00000000-0000-4000-8000-0000000000e2',
        name: 'B',
        rects: [{ x: 10, y: 1, w: 6, h: 6 }],
        mobsRect: { x: 11, y: 2, w: 4, h: 4 },
        description: '',
        monsterIndexes: [],
        spawn: false,
        key: '',
        keyTreasure: '',
      },
    ],
    corridors: [],
  };

  function testStatBlock(): StatBlock {
    return {
      ...blankStatBlock('dnd5e'),
      level: '3',
      size: 'Small',
      creatureType: 'humanoid (goblinoid)',
      ac: 14,
      acNote: 'leather armor',
      hp: 22,
      hpFormula: '5d6 + 5',
      speed: '30 ft.',
      abilities: { str: 8, dex: 16, con: 13, int: 14, wis: 10, cha: 12 },
      languages: 'Common, Goblin',
      traits: [{ name: 'Nimble Escape', text: 'Disengage or hide as a bonus action.' }],
      extras: { CR: '1' },
    };
  }

  async function seedNpc(extra?: {
    statBlock?: StatBlock | null;
    links?: ArtifactLink[];
  }): Promise<{ npc: Artifact; forge: Artifact }> {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const forge = await createArtifact({
      campaignId: campaign.id,
      kind: 'location',
      name: 'Forge',
    });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Grix',
      summary: 'Goblin alchemist boss.',
      body: '# Grix\nShe brews.',
      tags: ['goblin'],
      links: extra?.links ?? [],
      data: { ...NPC_DATA, statBlock: extra?.statBlock ?? null },
    });
    return { npc, forge };
  }

  beforeEach(clearDatabase);

  describe('editor surfaces', () => {
    it('markdown body toggles between editing and rendered preview', async () => {
      const user = userEvent.setup();
      const { npc, forge } = await seedNpc();
      render(
        <ArtifactEditor
          artifact={npc}
          campaignId={npc.campaignId}
          campaignArtifacts={[npc, forge]}
          campaignSystem="dnd5e"
        />,
      );

      const body = screen.getByPlaceholderText('Free-text content, written in Markdown…');
      await user.clear(body);
      await user.type(body, '## Brew{Enter}Brews deeply.');
      await user.click(screen.getByRole('button', { name: 'Preview' }));
      // Toggling swaps a textarea for a tall div → the ScrollArea resizes and
      // Base UI schedules an update; drain it inside act.
      await flushAsyncUpdates();

      // The textarea is replaced by rendered markdown.
      expect(screen.queryByPlaceholderText('Free-text content, written in Markdown…')).toBeNull();
      expect(screen.getByRole('heading', { level: 2, name: 'Brew' })).toBeInTheDocument();
      expect(screen.getByText('Brews deeply.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await flushAsyncUpdates();
      expect(screen.getByPlaceholderText('Free-text content, written in Markdown…')).toHaveValue(
        '## Brew\nBrews deeply.',
      );
      await flushAsyncUpdates();
    }, 20000);

    it('tag editor adds, deduplicates case-insensitively, and removes tags', async () => {
      const user = userEvent.setup();
      const { npc, forge } = await seedNpc();
      render(
        <ArtifactEditor
          artifact={npc}
          campaignId={npc.campaignId}
          campaignArtifacts={[npc, forge]}
          campaignSystem="dnd5e"
        />,
      );

      const input = screen.getByPlaceholderText('Add tag…');
      await user.type(input, 'alchemist{Enter}');
      await user.type(input, 'Alchemist,'); // duplicate, different case → ignored
      await user.type(input, 'boss{Enter}');

      expect(screen.getByText('boss')).toBeInTheDocument();
      expect(screen.getAllByText(/alchemist/i)).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: 'Remove tag alchemist' }));
      expect(screen.queryByText('alchemist')).toBeNull();

      // Persisted through autosave.
      await waitFor(
        async () => {
          const stored = await getArtifact(npc.id);
          expect(stored?.tags).toEqual(['goblin', 'boss']);
        },
        { timeout: 4_000 },
      );
      await flushAsyncUpdates();
    });

    it('links section adds, renames, and removes links', async () => {
      const user = userEvent.setup();
      const { npc, forge } = await seedNpc();
      render(
        <ArtifactEditor
          artifact={npc}
          campaignId={npc.campaignId}
          campaignArtifacts={[npc, forge]}
          campaignSystem="dnd5e"
        />,
      );

      // The target select is a Base UI combobox: open, pick 'Forge'.
      await user.click(screen.getByRole('combobox', { name: 'New relation target' }));
      await user.click(await screen.findByRole('option', { name: 'Forge' }));

      const add = screen.getByRole('button', { name: 'Add relation' });
      expect(add).toBeEnabled();
      await user.click(add);

      // Default relation applied; the row names the target artifact.
      const relation = screen.getByLabelText('Relation 1');
      expect(relation).toHaveValue('related-to');
      expect(relation.closest('div')?.textContent).toContain('Forge');

      // Editing the relation updates the row.
      await user.type(relation, ' inside');
      expect(screen.getByLabelText('Relation 1')).toHaveValue('related-to inside');

      // Removing clears the row.
      await user.click(screen.getByRole('button', { name: 'Remove relation 1' }));
      expect(screen.queryByLabelText('Relation 1')).toBeNull();

      await flushAsyncUpdates();
    });

    it('links referencing a deleted artifact render as dangling, not broken', async () => {
      const { npc, forge } = await seedNpc({
        links: [{ targetId: '00000000-0000-4000-8000-000000000000', relation: 'enemy-of' }],
      });
      render(
        <ArtifactEditor
          artifact={npc}
          campaignId={npc.campaignId}
          campaignArtifacts={[npc, forge]}
          campaignSystem="dnd5e"
        />,
      );

      expect(await screen.findByText('(deleted artifact)')).toBeInTheDocument();
      await flushAsyncUpdates();
    });

    it('stat block card renders, the edit form changes values, and it can be removed', async () => {
      const user = userEvent.setup();
      const { npc, forge } = await seedNpc({ statBlock: testStatBlock() });
      render(
        <ArtifactEditor
          artifact={npc}
          campaignId={npc.campaignId}
          campaignArtifacts={[npc, forge]}
          campaignSystem="dnd5e"
        />,
      );

      // Card view: headline, defenses with note, ability modifiers, traits, extras.
      expect(screen.getByRole('heading', { name: 'Grix' })).toBeInTheDocument();
      expect(screen.getByText('Small humanoid (goblinoid)')).toBeInTheDocument();
      expect(screen.getByText('AC').parentElement?.textContent).toContain('14 (leather armor)');
      expect(screen.getByText('DEX').parentElement?.textContent).toContain('16 (+3)');
      expect(screen.getByText('Nimble Escape.')).toBeInTheDocument();

      // Card → form → change HP → back to card.
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      const hp = screen.getByRole('spinbutton', { name: 'HP' });
      await user.clear(hp);
      await user.type(hp, '30');
      await user.click(screen.getByRole('button', { name: 'Done editing' }));
      expect(screen.getByText('HP').parentElement?.textContent).toContain('30 (5d6 + 5)');

      // Remove brings back the empty state (persisted via autosave).
      await user.click(screen.getByRole('button', { name: 'Remove' }));
      expect(screen.getByRole('button', { name: 'Add stat block' })).toBeInTheDocument();
      await waitFor(
        async () => {
          const stored = await getArtifact(npc.id);
          if (stored?.kind !== 'npc') throw new Error('not an npc');
          expect(stored.data.statBlock).toBeNull();
        },
        { timeout: 4_000 },
      );
      await flushAsyncUpdates();
    });

    it('revision dropdown opens the snapshot dialog and restore writes a new revision', async () => {
      const user = userEvent.setup();
      const { npc, forge } = await seedNpc();
      // Revision 2: change the body (listRevisions is newest-first).
      await act(async () => {
        const stored = await getArtifact(npc.id);
        if (stored === undefined) throw new Error('npc vanished');
        await updateArtifact(stored.id, { body: '# Grix, rewritten' });
      });
      const current = await getArtifact(npc.id);
      if (current === undefined) throw new Error('npc vanished');
      render(
        <ArtifactEditor
          artifact={current}
          campaignId={current.campaignId}
          campaignArtifacts={[current, forge]}
          campaignSystem="dnd5e"
        />,
      );
      expect(screen.getByTestId('revision-badge')).toHaveTextContent('rev 2');

      await user.click(screen.getByRole('button', { name: 'History' }));
      const menu = await screen.findByRole('menu');
      expect(within(menu).getByRole('menuitem', { name: /rev 2 · / })).toBeInTheDocument();
      expect(within(menu).getByRole('menuitem', { name: /rev 1 · / })).toBeInTheDocument();

      await user.click(within(menu).getByRole('menuitem', { name: /rev 1 · / }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Revision 1')).toBeInTheDocument();
      expect(within(dialog).getByText(/manual save/)).toBeInTheDocument();
      // The snapshot shows revision 1's body ('# Grix' renders as a heading),
      // not the current revision's body.
      expect(within(dialog).getByRole('heading', { level: 1, name: 'Grix' })).toBeInTheDocument();
      expect(within(dialog).getByText('She brews.')).toBeInTheDocument();
      expect(within(dialog).queryByText(/rewritten/)).toBeNull();

      await user.click(within(dialog).getByRole('button', { name: 'Restore this revision' }));
      // The restore transaction re-fires the revisions live query; drain it
      // inside act before plain DB reads.
      await flushAsyncUpdates();
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });

      // Restore = save snapshot as a new revision (05-UI §Revisions).
      const restored = await getArtifact(npc.id);
      expect(restored?.body).toBe('# Grix\nShe brews.');
      expect(restored?.currentRevision).toBe(3);
      const revisions = await listRevisions(npc.id);
      expect(revisions).toHaveLength(3);
      expect(revisions[0]?.revision).toBe(3);
      expect(revisions[0]?.source).toBe('user');
      await flushAsyncUpdates();
    }, 20000);

    it('content AI section hands off a refill request with two-step overwrite confirm', async () => {
      const user = userEvent.setup();
      const { npc } = await seedNpc();
      const { useContentRefillRequest } = await import('@/features/campaign/contentRefillRequest');
      const first = render(
        <ArtifactEditor
          artifact={npc}
          campaignId={npc.campaignId}
          campaignArtifacts={[npc]}
          campaignSystem="dnd5e"
        />,
      );

      // The artifact has content → the first press only ARMS the overwrite.
      const button = screen.getByTestId('generate-artifact-content');
      expect(button).toHaveTextContent('Regenerate with AI');
      await user.click(button);
      expect(button).toHaveTextContent('Overwrite content — confirm?');
      expect(useContentRefillRequest.getState().artifactId).toBeNull();

      // The second press fires the request: artifact + kind + regenerate.
      await user.click(button);
      const state = useContentRefillRequest.getState();
      expect(state.artifactId).toBe(npc.id);
      expect(state.kind).toBe('npc');
      expect(state.regenerate).toBe(true);
      act(() => {
        useContentRefillRequest.getState().clear();
      });
      first.unmount();

      // An empty artifact is a first generation: no arm, direct request.
      const empty = await createArtifact({
        campaignId: npc.campaignId,
        kind: 'npc',
        name: 'Empty Ernie',
        summary: '',
        body: '',
        data: { ...NPC_DATA },
      });
      render(
        <ArtifactEditor
          artifact={empty}
          campaignId={empty.campaignId}
          campaignArtifacts={[empty]}
          campaignSystem="dnd5e"
        />,
      );
      const fresh = screen.getByTestId('generate-artifact-content');
      expect(fresh).toHaveTextContent('Generate with AI');
      await user.click(fresh);
      expect(useContentRefillRequest.getState().regenerate).toBe(false);
      act(() => {
        useContentRefillRequest.getState().clear();
      });
      await flushAsyncUpdates();
    }, 20000);

    it('encounter AI section offers exactly two automatic actions plus the prose checkbox (docs/11 two-button regeneration)', async () => {
      const campaign = await createCampaign({ name: 'Restock', system: 'dnd5e' });
      const encounter = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Old Undercroft',
        summary: '',
        body: '',
        data: {
          difficulty: 'old',
          levelHint: '4',
          monsters: [
            {
              name: 'Tomb Ogre',
              count: 4,
              notes: '',
              treasure: '',
              source: { type: 'inline', statBlock: testStatBlock() },
            },
          ],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          preset: 'standard',
          locationKind: 'dungeon',
          siteShape: 'complex',
          budgetAdvisory: '',
          layout: null,
        },
      });
      render(
        <ArtifactEditor
          artifact={encounter}
          campaignId={encounter.campaignId}
          campaignArtifacts={[encounter]}
          campaignSystem="dnd5e"
        />,
      );
      const section = screen.getByTestId('encounter-ai-section');
      // The two automatic actions and nothing else…
      expect(within(section).getByTestId('encounter-regenerate-everything')).toHaveTextContent(
        'Regenerate everything',
      );
      expect(within(section).getByTestId('encounter-repopulate')).toHaveTextContent('Repopulate');
      expect(section).toHaveTextContent('Two automatic actions exist');
      // …plus the prose checkbox (name/prose stay authored unless ticked)…
      expect(section).toHaveTextContent('Also redesign name and prose');
      // …and the old one-fight content hand-off is gone.
      expect(screen.queryByTestId('generate-encounter-content')).not.toBeInTheDocument();
      // A roomless complex cannot repopulate — Regenerate everything first.
      expect(within(section).getByTestId('encounter-repopulate')).toBeDisabled();
      expect(within(section).getByTestId('encounter-regenerate-everything')).toBeEnabled();
      await flushAsyncUpdates();
    }, 20000);

    it('Repopulate states the roomless reason through the device — ONE statement of it, never a title', async () => {
      const user = userEvent.setup();
      const campaign = await createCampaign({ name: 'Roomless copy', system: 'dnd5e' });
      const roomless = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Empty Halls',
        summary: '',
        body: '',
        data: complexEncounterData(null),
      });
      render(
        <ArtifactEditor
          artifact={roomless}
          campaignId={roomless.campaignId}
          campaignArtifacts={[roomless]}
          campaignSystem="dnd5e"
        />,
      );

      // HELD: the reason is perceivable through the wrapper — the hidden node the
      // wrapper points at with `aria-describedby`, the tab stop, and the popup the
      // helper settles out of the document before hovering (docs/18 §2.3).
      await expectBlockedReason(
        user,
        'encounter-repopulate',
        'This dungeon has no rooms yet — Regenerate everything builds rooms and a map first',
      );
      // The sentence used to be written a SECOND time, as the first branch of the
      // child's `title`, under a comment that blessed the duplication by name
      // ("its own sentence, already in the `title`"). That copy is gone: a `title`
      // on a natively disabled button is rendered by no browser and reached by no
      // pointer or key, and a second copy is only a second place for the sentence
      // to drift (docs/18 §4, ledger 126).
      expect(screen.getByTestId('encounter-repopulate')).not.toHaveAttribute('title');
      await flushAsyncUpdates();
    }, 20000);

    it('Repopulate offers its DESCRIPTION only while it can act (stocked complex)', async () => {
      const campaign = await createCampaign({ name: 'Stocked copy', system: 'dnd5e' });
      const stocked = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Stocked Halls',
        summary: '',
        body: '',
        data: complexEncounterData(STOCKED_COMPLEX_LAYOUT),
      });
      render(
        <ArtifactEditor
          artifact={stocked}
          campaignId={stocked.campaignId}
          campaignArtifacts={[stocked]}
          campaignSystem="dnd5e"
        />,
      );

      // LIVE: a `title` is a surface only a control that can act ever exposes, so
      // this is where the description of what pressing the control does belongs —
      // byte-identical to the copy the old title carried on its live branch.
      const button = screen.getByTestId('encounter-repopulate');
      expect(button).toBeEnabled();
      expect(button).toHaveAttribute(
        'title',
        'New roster for all rooms — rooms, layout and map kept',
      );
      await flushAsyncUpdates();
    }, 20000);

    it('complex encounters offer a per-run map path choice for Regenerate everything (docs/11 vision path steering)', async () => {
      const user = userEvent.setup();
      const campaign = await createCampaign({ name: 'Steering', system: 'dnd5e' });
      const encounter = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Old Undercroft',
        summary: '',
        body: '',
        data: {
          difficulty: 'old',
          levelHint: '4',
          monsters: [
            {
              name: 'Tomb Ogre',
              count: 4,
              notes: '',
              treasure: '',
              source: { type: 'inline', statBlock: testStatBlock() },
            },
          ],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          preset: 'standard',
          locationKind: 'dungeon',
          siteShape: 'complex',
          budgetAdvisory: '',
          layout: null,
        },
      });
      render(
        <ArtifactEditor
          artifact={encounter}
          campaignId={encounter.campaignId}
          campaignArtifacts={[encounter]}
          campaignSystem="dnd5e"
        />,
      );
      const section = screen.getByTestId('encounter-ai-section');
      // The steering control starts at Use default (never a persisted choice)…
      const trigger = within(section).getByTestId('encounter-regen-map-path');
      expect(trigger).toHaveTextContent('Use default');
      expect(within(section).getByTestId('encounter-regen-map-path-hint')).toHaveTextContent(
        'follows the dungeon map path setting',
      );
      // …with one honest line per path.
      await user.click(trigger);
      await user.click(await screen.findByRole('option', { name: 'Vision-located labels' }));
      expect(trigger).toHaveTextContent('Vision-located labels');
      expect(within(section).getByTestId('encounter-regen-map-path-hint')).toHaveTextContent(
        'one painted map, room plaques located by sight',
      );
      await user.click(trigger);
      await user.click(await screen.findByRole('option', { name: 'Classic (vector rooms)' }));
      expect(trigger).toHaveTextContent('Classic (vector rooms)');
      expect(within(section).getByTestId('encounter-regen-map-path-hint')).toHaveTextContent(
        'packed vector rooms on the grid',
      );
      await flushAsyncUpdates();
    }, 20000);

    it('single encounters offer no map path choice (singles always map classic)', async () => {
      const campaign = await createCampaign({ name: 'Single Steering', system: 'dnd5e' });
      const encounter = await createArtifact({
        campaignId: campaign.id,
        kind: 'encounter',
        name: 'Gate Ambush',
        summary: '',
        body: '',
        data: {
          difficulty: 'old',
          levelHint: '3',
          monsters: [
            {
              name: 'Tomb Ogre',
              count: 4,
              notes: '',
              treasure: '',
              source: { type: 'inline', statBlock: testStatBlock() },
            },
          ],
          terrain: '',
          tactics: '',
          treasure: '',
          mapImageId: null,
          preset: 'standard',
          locationKind: 'other',
          siteShape: 'single',
          budgetAdvisory: '',
          layout: null,
        },
      });
      render(
        <ArtifactEditor
          artifact={encounter}
          campaignId={encounter.campaignId}
          campaignArtifacts={[encounter]}
          campaignSystem="dnd5e"
        />,
      );
      const section = screen.getByTestId('encounter-ai-section');
      expect(within(section).queryByTestId('encounter-regen-map-path')).not.toBeInTheDocument();
      expect(
        within(section).queryByTestId('encounter-regen-map-path-hint'),
      ).not.toBeInTheDocument();
      // Repopulate can act here, so it offers the single-site DESCRIPTION — the
      // other branch of the same gated `title` (docs/18 §4, ledger 126).
      expect(within(section).getByTestId('encounter-repopulate')).toHaveAttribute(
        'title',
        'New one-fight roster — map kept',
      );
      await flushAsyncUpdates();
    }, 20000);
  });
});

describe('guide.test.tsx', () => {
  /**
   * First-module guide (05-UI.md §Guide): content completeness (helpContent
   * pattern), route-table validity of every chapter's app link, the page's
   * chapter navigation, campaign-scoped CTA resolution and the entry points
   * (wizard step 6, modules empty state).
   */

  function renderAppAt(path: string): void {
    window.history.replaceState(null, '', path);
    render(<RouterProvider router={createAppRouter()} />);
  }

  beforeEach(async () => {
    await clearDatabase();
    useOnboardingStore.setState({ open: false, focusStep: null });
    // The guide is not the wizard's owner — keep the auto-open quiet here.
    await saveSettings({
      ...defaultSettings(),
      onboarding: { status: 'complete' as const, stepState: [] },
    });
  });
  afterEach(() => {
    cleanup();
  });

  describe('guide content registry', () => {
    it('is complete: nine chapters, unique ids, populated sections and checkpoints', () => {
      expect(GUIDE_CHAPTERS).toHaveLength(9);
      const seen = new Set<string>();
      for (const chapter of GUIDE_CHAPTERS) {
        expect(seen.has(chapter.id)).toBe(false);
        seen.add(chapter.id);
        expect(chapter.title.length).toBeGreaterThan(3);
        expect(chapter.intro.length).toBeGreaterThan(20);
        expect(chapter.minutes).toBeGreaterThan(0);
        expect(chapter.checkpoint.length).toBeGreaterThan(10);
        expect(chapter.sections.length).toBeGreaterThanOrEqual(1);
        for (const section of chapter.sections) {
          expect(section.heading.length).toBeGreaterThan(3);
          expect(section.markdown.length).toBeGreaterThan(20);
        }
      }
    });

    it('covers the authored path in order', () => {
      expect(GUIDE_CHAPTERS.map((chapter) => chapter.id)).toEqual([
        'start-here',
        'campaign',
        'rules',
        'create-module',
        'spine',
        'parts',
        'cast',
        'battlemaps',
        'table',
      ]);
    });

    it('every app link points at a real route', () => {
      const staticPaths: ReadonlySet<string> = new Set<string>(Object.values(ROUTES));
      for (const chapter of GUIDE_CHAPTERS) {
        const link = chapter.appLink;
        if (link === undefined) continue;
        if (link.route.kind === 'static') {
          expect(staticPaths.has(link.route.path)).toBe(true);
        } else {
          expect(['workspace', 'modules']).toContain(link.route.section);
        }
      }
    });
  });

  describe('GuidePage', () => {
    it('renders the first chapter with chapter navigation', async () => {
      renderAppAt(guidePath());
      expect(await screen.findByTestId('guide-chapter')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Start here' })).toBeInTheDocument();
      for (const chapter of GUIDE_CHAPTERS) {
        expect(screen.getByTestId(`guide-nav-${chapter.id}`)).toBeInTheDocument();
      }
      expect(screen.getByTestId('guide-checkpoint')).toBeInTheDocument();
      // First chapter has no back link.
      expect(screen.queryByTestId('guide-prev')).toBeNull();
    }, 20000);

    it('navigates to a chapter by route and offers prev/next', async () => {
      renderAppAt(guidePath('spine'));
      expect(await screen.findByRole('heading', { name: 'Approve the spine' })).toBeInTheDocument();
      expect(screen.getByTestId('guide-prev')).toHaveTextContent('Create the module');
      expect(screen.getByTestId('guide-next')).toHaveTextContent('Read, edit, rewrite');

      const user = userEvent.setup();
      await user.click(screen.getByTestId('guide-next'));
      expect(
        await screen.findByRole('heading', { name: 'Read, edit, rewrite' }),
      ).toBeInTheDocument();
      expect(window.location.pathname).toBe(guidePath('parts'));
    }, 20000);

    it('renders the not-found page for an unknown chapter id', async () => {
      renderAppAt(guidePath('not-a-chapter'));
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    }, 20000);

    it('resolves campaign-scoped CTAs against the most recent campaign', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      renderAppAt(guidePath('spine'));
      await flushAsyncUpdates();
      const link = await screen.findByTestId('guide-app-link');
      expect(link).toHaveAttribute('href', modulesPath(campaign.id));
      expect(link).toHaveAttribute('target', '_blank');
    }, 20000);

    it('renders a disabled hint for campaign-scoped CTAs without a campaign', async () => {
      renderAppAt(guidePath('spine'));
      await flushAsyncUpdates();
      expect(await screen.findByTestId('guide-app-link-disabled')).toHaveTextContent(
        'create a campaign first',
      );
    }, 20000);
  });

  describe('guide entry points', () => {
    it("the wizard's author step links to the guide in a new tab", async () => {
      renderAppAt(ROUTES.campaignPicker);
      act(() => {
        useOnboardingStore.getState().openWizard('author');
      });
      await screen.findByTestId('setup-wizard');
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-author')).toHaveAttribute('aria-expanded', 'true');
      });
      const link = screen.getByTestId('wizard-link-guide');
      expect(link).toHaveAttribute('href', guidePath());
      expect(link).toHaveAttribute('target', '_blank');
    }, 20000);

    it('the modules empty state links to the guide', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      renderAppAt(modulesPath(campaign.id));
      const empty = await screen.findByTestId('modules-empty-guide');
      expect(empty).toHaveAttribute('href', guidePath());
      expect(empty).toHaveAttribute('target', '_blank');
    }, 20000);
  });
});

describe('onboarding-wizard.test.tsx', () => {
  /**
   * First-run setup wizard (05-UI.md §Onboarding): the one-time auto-open on a
   * fresh, empty browser, its skip/resume semantics, detection auto-ticks, the
   * Finish/dismiss persistence and the re-open affordances. App-shell tests
   * seed a settled onboarding row instead — the wizard must never hijack a
   * shell test.
   *
   * Leak discipline (docs/08 §Console guard): the real app shell is mounted
   * here, so its live queries (settings, campaigns) and the wizard dialog's
   * own queries re-fire on fake-indexeddb's timed queue. The auto-open's
   * `setOnboardingStatus('active')` write and every step/status write land
   * AFTER the act-wrapped step that triggered them, and Base UI's dialog exit
   * transition schedules rAF/timer updates of its own — raw awaited
   * `readSettings()` reads are wrapped in `actDrained` and every test ends
   * with `flushAsyncUpdates()` so the cascades drain inside act.
   */

  function renderAppAt(path: string): void {
    window.history.replaceState(null, '', path);
    render(<RouterProvider router={createAppRouter()} />);
  }

  function openWizard(focus?: OnboardingStepId): void {
    act(() => {
      useOnboardingStore.getState().openWizard(focus);
    });
  }

  beforeEach(async () => {
    await clearDatabase();
    useOnboardingStore.setState({ open: false, focusStep: null });
    useHelpStore.setState({ topic: null });
  });
  afterEach(() => {
    cleanup();
  });

  describe('auto-open', () => {
    it('opens once on a fresh empty browser and persists "active" (never again)', async () => {
      renderAppAt(ROUTES.campaignPicker);
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      await waitFor(() => {
        expect(useOnboardingStore.getState().open).toBe(true);
      });
      await flushAsyncUpdates();
      // Raw awaited read while the shell is mounted — actDrained closes the
      // leak window (the auto-open's status write re-fires the settings
      // live queries on the timed queue).
      const status = (await actDrained(() => readSettings())).onboarding.status;
      expect(status).toBe('active');

      // Second launch on the same browser: no auto-open.
      cleanup();
      act(() => {
        useOnboardingStore.setState({ open: false, focusStep: null });
      });
      renderAppAt(ROUTES.campaignPicker);
      await flushAsyncUpdates();
      expect(screen.queryByTestId('setup-wizard')).toBeNull();
      await flushAsyncUpdates();
    }, 20000);

    it('does not auto-open when campaigns already exist (upgrade safety)', async () => {
      await createCampaign({ name: 'Ember', system: 'dnd5e' });
      renderAppAt(ROUTES.campaignPicker);
      await flushAsyncUpdates();
      expect(screen.queryByTestId('setup-wizard')).toBeNull();
      // The status stays 'fresh' so a genuinely first run still gets it.
      expect((await actDrained(() => readSettings())).onboarding.status).toBe('fresh');
      await flushAsyncUpdates();
    }, 20000);

    it('does not auto-open when dismissed', async () => {
      await saveSettings({
        ...defaultSettings(),
        onboarding: { status: 'dismissed' as const, stepState: [] },
      });
      renderAppAt(ROUTES.campaignPicker);
      await flushAsyncUpdates();
      expect(screen.queryByTestId('setup-wizard')).toBeNull();
      expect((await actDrained(() => readSettings())).onboarding.status).toBe('dismissed');
      await flushAsyncUpdates();
    }, 20000);
  });

  describe('checklist semantics', () => {
    it('starts expanded on the welcome step; Begin resolves it and focuses the next step', async () => {
      renderAppAt(ROUTES.campaignPicker);
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      // Expansion waits for the settings live query on first mount.
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-welcome')).toHaveAttribute('aria-expanded', 'true');
      });

      const user = userEvent.setup();
      await user.click(screen.getByTestId('wizard-begin'));
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-welcome')).toHaveAttribute('aria-expanded', 'false');
        expect(screen.getByTestId('wizard-row-openrouter')).toHaveAttribute(
          'aria-expanded',
          'true',
        );
      });
      // The Begin write's liveQuery cascade drains inside act (docs/08).
      expect((await actDrained(() => readSettings())).onboarding.stepState).toEqual([
        { id: 'welcome', state: 'done' },
      ]);
      await flushAsyncUpdates();
    }, 20000);

    it('Skip persists as skipped and the wizard resumes at the first unresolved step', async () => {
      renderAppAt(ROUTES.campaignPicker);
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-welcome')).toHaveAttribute('aria-expanded', 'true');
      });
      const user = userEvent.setup();
      await user.click(screen.getByTestId('wizard-begin'));
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-openrouter')).toHaveAttribute(
          'aria-expanded',
          'true',
        );
      });
      await user.click(screen.getByTestId('wizard-skip-openrouter'));

      // Raw awaited read while the shell + dialog are mounted — actDrained
      // closes the leak window opened by the skip's settings write (docs/08).
      const onboarding = (await actDrained(() => readSettings())).onboarding;
      expect(onboarding.stepState).toEqual([
        { id: 'welcome', state: 'done' },
        { id: 'openrouter', state: 'skipped' },
      ]);

      // Close and re-open: the first unresolved step (language) is focused.
      cleanup();
      act(() => {
        useOnboardingStore.setState({ open: false, focusStep: null });
      });
      renderAppAt(ROUTES.campaignPicker);
      const user2 = userEvent.setup();
      await user2.click(await screen.findByTestId('get-set-up'));
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-language')).toHaveAttribute('aria-expanded', 'true');
      });
      await flushAsyncUpdates();
    }, 20000);

    it('auto-ticks a pending step when its detection signal fires (saved key)', async () => {
      await saveSettings({
        ...defaultSettings(),
        openRouterApiKey: 'sk-or-test',
        onboarding: { status: 'active' as const, stepState: [{ id: 'welcome', state: 'done' }] },
      });
      renderAppAt(ROUTES.campaignPicker);
      openWizard('openrouter');
      await screen.findByTestId('setup-wizard');
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-openrouter')).toHaveAttribute(
          'aria-expanded',
          'true',
        );
      });
      const step = screen.getByTestId('wizard-step-openrouter');
      expect(within(step).getByLabelText('done')).toBeInTheDocument();
      await waitFor(async () => {
        const onboarding = (await readSettings()).onboarding;
        expect(onboarding.stepState).toContainEqual({ id: 'openrouter', state: 'done' });
      });
      // The auto-tick's settings write can straggle past waitFor's last poll —
      // drain it inside act (docs/08).
      await flushAsyncUpdates();
    }, 20000);

    it('shows campaign/module sub-progress on the author step', async () => {
      await createCampaign({ name: 'Ember', system: 'dnd5e' });
      renderAppAt(ROUTES.campaignPicker);
      openWizard('author');
      await screen.findByTestId('setup-wizard');
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-author')).toHaveAttribute('aria-expanded', 'true');
      });
      const step = screen.getByTestId('wizard-step-author');
      expect(within(step).getByTestId('wizard-detail-campaign')).toHaveTextContent('✓');
      expect(within(step).getByTestId('wizard-detail-module')).toHaveTextContent('·');
      await flushAsyncUpdates();
    }, 20000);
  });

  describe('completion + dismissal persistence', () => {
    it('Finish stays disabled until every step is resolved, then marks complete', async () => {
      await saveSettings({
        ...defaultSettings(),
        onboarding: {
          status: 'active' as const,
          stepState: [
            { id: 'welcome', state: 'done' },
            { id: 'openrouter', state: 'done' },
            { id: 'language', state: 'skipped' },
            { id: 'rulebook', state: 'done' },
            { id: 'pack', state: 'skipped' },
          ],
        },
      });
      renderAppAt(ROUTES.campaignPicker);
      openWizard();
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      expect(screen.getByTestId('wizard-finish')).toBeDisabled();

      // Resolve the last pending step (author) — it is already the expanded
      // focus step (first unresolved); expanding rows toggles, so just act.
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-author')).toHaveAttribute('aria-expanded', 'true');
      });
      const user = userEvent.setup();
      await user.click(screen.getByTestId('wizard-done-author'));
      await waitFor(() => {
        expect(screen.getByTestId('wizard-finish')).toBeEnabled();
      });
      await user.click(screen.getByTestId('wizard-finish'));
      await waitFor(() => {
        expect(useOnboardingStore.getState().open).toBe(false);
      });
      // Raw awaited read while the shell is mounted; the Finish write and the
      // dialog's exit transition land on the timed queue — actDrained + a
      // final drain keep them inside act (docs/08).
      expect((await actDrained(() => readSettings())).onboarding.status).toBe('complete');
      await flushAsyncUpdates();
    }, 20000);

    it('"Don\'t show again" persists dismissed and closes', async () => {
      renderAppAt(ROUTES.campaignPicker);
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(screen.getByTestId('wizard-dismiss'));
      await waitFor(() => {
        expect(useOnboardingStore.getState().open).toBe(false);
      });
      expect((await actDrained(() => readSettings())).onboarding.status).toBe('dismissed');
      await flushAsyncUpdates();
    }, 20000);
  });

  describe('steps link out to existing surfaces', () => {
    it('navigates on an internal link (closing the dialog) and renders the external anchor', async () => {
      renderAppAt(ROUTES.campaignPicker);
      openWizard('openrouter');
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('wizard-row-openrouter')).toHaveAttribute(
          'aria-expanded',
          'true',
        );
      });

      const external = screen.getByTestId('wizard-link-openrouter-keys');
      expect(external).toHaveAttribute('href', 'https://openrouter.ai/keys');
      expect(external).toHaveAttribute('target', '_blank');

      const user = userEvent.setup();
      await user.click(screen.getByTestId('wizard-link-settings'));
      await waitFor(() => {
        expect(useOnboardingStore.getState().open).toBe(false);
      });
      expect(window.location.pathname).toBe(ROUTES.settings);
      // The closed dialog's exit transition (Base UI unmounts it after the
      // transition) drains inside act (docs/08).
      await flushAsyncUpdates();
    }, 20000);
  });

  describe('re-open affordances', () => {
    it('picker header button opens the wizard; hidden when complete', async () => {
      renderAppAt(ROUTES.campaignPicker);
      const user = userEvent.setup();
      await user.click(await screen.findByTestId('get-set-up'));
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      // The auto-open's status write (it fired on this fresh shell) can
      // straggle past the findBy act — drain it (docs/08).
      await flushAsyncUpdates();
    }, 20000);

    it('welcome panel offers "Set up Campaigner" while the wizard is unfinished', async () => {
      const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
      await saveSettings({
        ...defaultSettings(),
        onboarding: { status: 'active' as const, stepState: [] },
      });
      renderAppAt(workspacePath(campaign.id));
      expect(await screen.findByTestId('welcome-set-up')).toBeInTheDocument();
      const user = userEvent.setup();
      await user.click(screen.getByTestId('welcome-set-up'));
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      await flushAsyncUpdates();
    }, 20000);

    it("help's setup topic reopens the wizard and closes help", async () => {
      renderAppAt(ROUTES.campaignPicker);
      act(() => {
        useHelpStore.setState({ topic: 'setup' });
      });
      const user = userEvent.setup();
      await user.click(await screen.findByTestId('help-reopen-wizard'));
      expect(await screen.findByTestId('setup-wizard')).toBeInTheDocument();
      // Base UI unmounts the closing dialog after its exit transition.
      await waitFor(() => {
        expect(screen.queryByTestId('help-dialog')).toBeNull();
      });
      await flushAsyncUpdates();
    }, 20000);
  });
});
