import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  moduleSchema,
  type Campaign,
  type Module,
  type PersonaRun,
} from '@/domain';
import { changeArtifact } from '@/features/modules/change-artifact';
import { runEntityBatch } from '@/features/modules/entity-batch';
import type * as runEngineModule from '@/llm/runEngine';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * The entity intent note reaches the DETAIL WORKER through the one seam every
 * entity generation passes (08 §M4-C "Entity intent", docs/17 row 141).
 *
 * The brief itself is pinned in `tests/features/entity-intent-brief.test.tsx`;
 * this file pins the WIRING — that the note recorded on the module's entity
 * record is READ and handed to the brief by the batch, and that the CHANGE /
 * refill lane receives it too (it re-enters through `runEntityBatch` with the
 * module row, which is why it is covered by construction as well as by the
 * explicit pin below).
 *
 * The engine is faked — the brief STRING is the assertion target.
 */

const { startRunMock, waitForStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  waitForStatusMock: vi.fn(),
}));

vi.mock('@/llm/runEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof runEngineModule>();
  return {
    isRunWithdrawn: actual.isRunWithdrawn,
    runNotCompletedReason: actual.runNotCompletedReason,
    runEngine: { on: () => () => undefined, startRun: startRunMock },
    waitForRunStatus: waitForStatusMock,
  };
});

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastErrorPersistent: vi.fn(),
}));

const NAME = 'The Salt Market';
const NOTE = 'The market is a front for the smugglers; play the bustle as fear.';
const MENTION = `Dusk falls on [[${NAME}]], and the stalls empty.`;

/** A run that died on its own — the brief was already sent by then. */
function failedWith(message: string): PersonaRun {
  return {
    status: 'failed',
    resultArtifactId: null,
    errorMessage: message,
    failureKind: null,
  } as unknown as PersonaRun;
}

let consoleSpy: MockInstance<(...data: unknown[]) => void>;

function briefs(): string[] {
  return startRunMock.mock.calls.map((call) => {
    const input = call[0] as { brief?: unknown };
    return typeof input.brief === 'string' ? input.brief : '';
  });
}

async function seedModule(intent: string | undefined): Promise<{ campaign: Campaign; module: Module }> {
  const campaign = await createCampaign({ name: 'Harbor Campaign', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself.',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'standard',
  });
  const module = await saveModule(
    moduleSchema.parse({
      ...draft,
      entityKinds: [
        { name: NAME, kind: 'location', absorbed: [], ...(intent === undefined ? {} : { intent }) },
        { name: 'The Old Pier', kind: 'location', absorbed: [] },
      ],
      spine: {
        premise: `The bell rings over [[${NAME}]].`,
        themes: [],
        partPlan: [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
        writerModel: '',
        origin: null,
      },
      parts: [
        {
          planIndex: 0,
          markdown: MENTION,
          status: 'ready',
          errorMessage: '',
          edited: false,
          writerModel: '',
          origin: null,
        },
      ],
    }),
  );
  await seedBuiltInPersonas();
  return { campaign, module };
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  startRunMock.mockReset();
  waitForStatusMock.mockReset();
  startRunMock.mockResolvedValue('run-1');
  waitForStatusMock.mockResolvedValue(failedWith('the faked run died'));
  // The faked failure makes the batch's own reporting seam write its record
  // down (docs/17 row 131) — SPY, not noise-suppression: the records are left
  // unasserted here (they are pinned in `entity-batch-failure-report.test.ts`)
  // and the spy keeps the run's console clean (tests/setup.ts allowance rule).
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('the batch hands the record’s note to the detail worker', () => {
  it('a target whose record carries an intent gets the paragraph in its brief', async () => {
    const { campaign, module } = await seedModule(NOTE);
    await runEntityBatch({
      module,
      campaign,
      kind: 'location',
      targets: [{ name: NAME }],
    });
    const brief = briefs()[0] ?? '';
    expect(brief).toContain("The module's author intended:");
    expect(brief).toContain(NOTE);
    // The paragraph is the brief's LAST paragraph before any instruction — the
    // batch passes none, so it closes the brief.
    expect(brief.endsWith('what this kind may contain.')).toBe(true);
  });

  it('a target with NO note gets a brief with no intent paragraph at all', async () => {
    const { campaign, module } = await seedModule(undefined);
    await runEntityBatch({
      module,
      campaign,
      kind: 'location',
      targets: [{ name: NAME }],
    });
    const brief = briefs()[0] ?? '';
    expect(brief).not.toContain("The module's author intended:");
    expect(brief.endsWith('what this kind may contain.')).toBe(false);
  });

  it('the note is read per ENTITY: the neighbour with no note stays clean', async () => {
    const { campaign, module } = await seedModule(NOTE);
    await runEntityBatch({
      module,
      campaign,
      kind: 'location',
      targets: [{ name: NAME }, { name: 'The Old Pier' }],
    });
    const [first, second] = briefs();
    expect(first).toContain(NOTE);
    expect(second).not.toContain(NOTE);
  });
});

describe('the change/refill lane receives it too (the seam the owner uses to see the difference)', () => {
  it('changing an existing entity re-sends the brief WITH the recorded note', async () => {
    const { campaign, module } = await seedModule(NOTE);
    const artifact = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'location',
      name: NAME,
      summary: 'A market.',
      body: MENTION,
      data: { locationType: 'city', inhabitants: '', pointsOfInterest: [], hooks: [] },
    });

    // The change lane runs the SAME brief through the one batch seam; the faked
    // run dies, which is irrelevant here — the brief was already sent.
    await expect(changeArtifact({ artifactId: artifact.id })).rejects.toThrow(
      /did not complete/,
    );
    const brief = briefs()[0] ?? '';
    expect(brief).toContain("The module's author intended:");
    expect(brief).toContain(NOTE);
  });

  it('a change to an entity with NO note sends the pre-change brief bytes', async () => {
    const { campaign, module } = await seedModule(undefined);
    const artifact = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'location',
      name: NAME,
      summary: 'A market.',
      body: MENTION,
      data: { locationType: 'city', inhabitants: '', pointsOfInterest: [], hooks: [] },
    });
    await expect(changeArtifact({ artifactId: artifact.id })).rejects.toThrow(/did not complete/);
    expect(briefs()[0] ?? '').not.toContain("The module's author intended:");
  });
});
