import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type * as runEngineModule from '@/llm/runEngine';
import type * as mobPortraitQueueModule from '@/features/campaign/mob-portrait-queue';
import { createArtifact, getAnyArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, type Id } from '@/domain';
import { createModule as saveModule } from '@/db/moduleRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { listBattlesByModule } from '@/db/battleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { SpawnPicker } from '@/features/play/battle/SpawnPicker';
import { authorAndSpawnMob } from '@/features/play/battle/spawn-picker-logic';
import { authoredPortraitKey } from '@/features/campaign/mob-portrait-participants';
import { useProgressStore } from '@/lib/progress';
import { toastError, toastSuccess } from '@/lib/toast';
import { spawnPickerStatBlock } from '../helpers/spawn-picker-fixtures';
import { currentBattle } from '../helpers/battle-surface-route';
import { clearDatabase } from '../db/helpers';

/**
 * "Author a new mob" (docs/17 row 333, part 2; owner, verbatim: *"i would like
 * to have a possibility to spawn a freshly authored mob (with stat block
 * always), using npc smith."*).
 *
 * THE DESIGN RULE THIS FILE EXISTS FOR: the mob's level is a STRUCTURED form
 * value bound to the run's `entityLevelHint`, which WINS over any `level N`
 * sentence in the free-text description — and the surface NAMES the level it
 * used. The engine's own behavioural pin for that precedence lives in
 * `tests/llm/runEngine.test.ts` ("the structured level hint WINS over a
 * conflicting `level N` sentence in the brief — AND BINDS it"); this file pins
 * that THIS surface hands it over and says so, and that "with stat block
 * always" is enforced: a failed or blockless run spawns NOTHING, loudly.
 */

const { startRunMock, waitForRunStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  waitForRunStatusMock: vi.fn(),
}));

vi.mock('@/llm/runEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof runEngineModule>();
  return {
    ...actual,
    runEngine: { startRun: startRunMock },
    waitForRunStatus: waitForRunStatusMock,
  };
});

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/features/campaign/mob-portrait-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof mobPortraitQueueModule>();
  return { ...actual, enqueueSingleMobPortrait: vi.fn(actual.enqueueSingleMobPortrait) };
});

const { enqueueSingleMobPortrait } = await import('@/features/campaign/mob-portrait-queue');
const enqueueMock = vi.mocked(enqueueSingleMobPortrait);
/** The store's own `start`, before this file wraps it to observe dock jobs. */
const realProgressStart = useProgressStore.getState().start;

let campaignId = '';
let moduleId = '';
let battleId = '';
/** The input the picker handed `runEngine.startRun` for the last authoring. */
let lastStartRun: Record<string, unknown> | null = null;
/** How the mocked run settles: whether its block lands, and its terminal status. */
let runWillWriteBlock = true;
let runTerminal: { status: string; errorMessage: string } = { status: 'completed', errorMessage: '' };

beforeEach(async () => {
  await clearDatabase();
  vi.resetAllMocks();
  lastStartRun = null;
  runWillWriteBlock = true;
  runTerminal = { status: 'completed', errorMessage: '' };
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });

  campaignId = (await createCampaign({ name: 'Author a mob', system: 'dnd5e' })).id;
  await seedBuiltInPersonas();
  // An encounter with NO roster and no layout: the board starts EMPTY, so
  // "exactly ONE new mob token" is an unambiguous count.
  const encounter = await createArtifact({
    campaignId,
    kind: 'encounter',
    name: 'Empty arena',
    data: {
      difficulty: 'medium',
      levelHint: '',
      partyLevel: 3,
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
  const module = await saveModule(
    createModule({
      campaignId,
      title: 'Author Module',
      concept: '',
      levelMin: 1,
      levelMax: 20,
      sizeDial: 'sketch',
    }),
  );
  moduleId = module.id;
  await seedBattleFromEncounter(campaignId, moduleId, encounter.id);
  const [battle] = await listBattlesByModule(moduleId);
  if (battle === undefined) throw new Error('battle row missing');
  battleId = battle.id;

  // The house double for a run: it records the input, optionally writes the
  // stat block the engine's own statblock step would persist, and returns an id
  // the (mocked) wait boundary answers for.
  startRunMock.mockImplementation(async (input: Record<string, unknown>) => {
    lastStartRun = input;
    if (runWillWriteBlock) {
      const targetId = input.targetArtifactId as Id;
      const target = await getAnyArtifact(targetId);
      if (target?.kind !== 'npc') throw new Error('mock: the run target is not an npc');
      await updateArtifact(targetId, {
        data: { ...target.data, statBlock: spawnPickerStatBlock('7', 44) },
      });
    }
    return 'run-1';
  });
  waitForRunStatusMock.mockImplementation(() => Promise.resolve(runTerminal));
});

afterEach(() => {
  cleanup();
  useProgressStore.setState({ start: realProgressStart });
  delete (HTMLElement.prototype as unknown as { offsetWidth?: unknown }).offsetWidth;
  delete (HTMLElement.prototype as unknown as { offsetHeight?: unknown }).offsetHeight;
});

async function renderPicker(): Promise<void> {
  const artifacts = await listArtifactsByCampaign(campaignId);
  render(
    <SpawnPicker
      open
      onOpenChange={() => undefined}
      battleId={battleId}
      campaignId={campaignId}
      roster={[]}
      encounterName="Empty arena"
      artifacts={artifacts}
    />,
  );
  await waitFor(() => {
    expect(screen.getByTestId('spawn-picker-author')).toBeInTheDocument();
  });
}

async function fillAndSubmit(name: string, level: string, description: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByTestId('author-mob-name'), name);
  await user.type(screen.getByTestId('author-mob-level'), level);
  await user.type(screen.getByTestId('author-mob-description'), description);
  await user.click(screen.getByTestId('author-mob-submit'));
}

describe('spawn picker author-and-spawn (docs/17 row 333, part 2)', () => {
  it('hands the run the STRUCTURED level (7) — never the "level 2" in the description — and NAMES the level it used', async () => {
    // The in-flight surface's own record: the dock job names the level.
    const started: { label: string; detail: string }[] = [];
    useProgressStore.setState({
      start: (id, label, detail) => {
        started.push({ label, detail: detail ?? '' });
        realProgressStart(id, label, detail);
      },
    });

    await renderPicker();
    await fillAndSubmit('Goblin Chief', '7', 'A hulking brute. The old notes say level 2.');
    await waitFor(() => {
      expect(vi.mocked(toastSuccess)).toHaveBeenCalled();
    });

    // (a) THE AUTHORITY: the structured hint rides the run, and the description
    // is passed VERBATIM as the brief — it is never read for a level here.
    expect(lastStartRun).not.toBeNull();
    expect(lastStartRun?.entityLevelHint).toBe(7);
    expect(lastStartRun?.brief).toBe('A hulking brute. The old notes say level 2.');
    expect(lastStartRun?.pinnedChunkIds).toEqual([]);
    expect(lastStartRun?.autonomy).toBe('auto');
    const npcId = lastStartRun?.targetArtifactId as Id;
    expect(typeof npcId).toBe('string');

    // (b) THE SURFACE NAMES THE LEVEL IT USED — in flight and on success.
    expect(started.some((job) => job.detail.includes('Level 7'))).toBe(true);
    expect(vi.mocked(toastSuccess).mock.calls[0]?.[0]).toContain('level 7');

    // (c) The stat block is on the npc row, and the mob spawned through the
    // standard path — exactly ONE new token, pointing at that row.
    const row = await getAnyArtifact(npcId);
    expect(row?.kind === 'npc' && row.data.statBlock?.level).toBe('7');
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens).toHaveLength(1);
    expect(battle.board.tokens[0]?.label).toBe('Goblin Chief 1');
    expect(battle.board.tokens[0]?.artifactId).toBe(npcId);
    // An npc-ref spawn is BY REFERENCE: no frozen seed row is added.
    expect(battle.seedFighters).toHaveLength(0);
    expect(vi.mocked(toastError)).not.toHaveBeenCalled();
  });

  it('a FAILED run spawns NOTHING and says so loudly', async () => {
    runTerminal = { status: 'failed', errorMessage: 'the model exploded' };
    await renderPicker();
    await fillAndSubmit('Doomed Mob', '4', 'It will not survive.');
    await waitFor(() => {
      expect(vi.mocked(toastError)).toHaveBeenCalled();
    });
    // The run's own reason reaches the surface's message.
    const failure = vi.mocked(toastError).mock.calls[0]?.[1] as Error;
    expect(failure.message).toContain('the model exploded');
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens).toHaveLength(0);
    expect(battle.seedFighters).toHaveLength(0);
    expect(vi.mocked(toastSuccess)).not.toHaveBeenCalled();
  });

  it('a BLOCKLESS result spawns NOTHING and says so loudly ("with stat block always")', async () => {
    runWillWriteBlock = false;
    await renderPicker();
    await fillAndSubmit('Hollow Mob', '9', 'No numbers for you.');
    await waitFor(() => {
      expect(vi.mocked(toastError)).toHaveBeenCalled();
    });
    const failure = vi.mocked(toastError).mock.calls[0]?.[1] as Error;
    expect(failure.message).toContain('no stat block');
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens).toHaveLength(0);
    expect(vi.mocked(toastSuccess)).not.toHaveBeenCalled();
  });

  it('illustrates the freshly authored mob when the checkbox is ticked (part 1 rides the same path)', async () => {
    await renderPicker();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('spawn-picker-illustrate'));
    await fillAndSubmit('Painted Mob', '5', 'A mob that needs a face.');
    await waitFor(() => {
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
    const npcId = lastStartRun?.targetArtifactId as Id;
    expect(enqueueMock).toHaveBeenCalledWith({
      campaignId,
      creatureKey: authoredPortraitKey(npcId),
      name: 'Painted Mob',
      artifactId: npcId,
    });
  });

  it('illustrates the freshly authored mob when the AUTHOR section’s own tick is used — one flag, one path (docs/17 row 336, defect B)', async () => {
    await renderPicker();
    const user = userEvent.setup();
    // The owner looked for the tick here: the author section carries its own
    // instance of the SAME control, bound to the same flag.
    await user.click(screen.getByTestId('spawn-picker-author-illustrate'));
    expect(screen.getByTestId('spawn-picker-illustrate')).toHaveAttribute('aria-checked', 'true');
    await fillAndSubmit('Painted Mob', '5', 'A mob that needs a face.');
    await waitFor(() => {
      expect(enqueueMock).toHaveBeenCalledTimes(1);
    });
    const npcId = lastStartRun?.targetArtifactId as Id;
    expect(enqueueMock).toHaveBeenCalledWith({
      campaignId,
      creatureKey: authoredPortraitKey(npcId),
      name: 'Painted Mob',
      artifactId: npcId,
    });
  });

  it('authoring with the tick OFF spawns WITHOUT illustrating (the author tick is not a second default)', async () => {
    await renderPicker();
    await fillAndSubmit('Plain Mob', '4', 'No face needed.');
    await waitFor(() => {
      expect(vi.mocked(toastSuccess)).toHaveBeenCalled();
    });
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens.some((token) => token.label.startsWith('Plain Mob'))).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('a level outside 1..20 is REFUSED before any run starts', async () => {
    await expect(
      authorAndSpawnMob({
        campaignId,
        battleId,
        name: 'Impossible',
        level: 25,
        description: 'Nope.',
        illustrate: false,
      }),
    ).rejects.toThrow(/whole number from 1 to 20/);
    await expect(
      authorAndSpawnMob({
        campaignId,
        battleId,
        name: 'Impossible',
        level: 2.5,
        description: 'Nope.',
        illustrate: false,
      }),
    ).rejects.toThrow(/whole number from 1 to 20/);
    expect(startRunMock).not.toHaveBeenCalled();
    const battle = await currentBattle(moduleId);
    expect(battle.board.tokens).toHaveLength(0);
  });
});
