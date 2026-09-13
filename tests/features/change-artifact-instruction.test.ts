import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildEntityBrief } from '@/features/modules/persona-request';
import type * as runEngineModule from '@/llm/runEngine';

/**
 * The instruction's ARRIVAL — the half of the change seam that is about bytes
 * rather than routing (docs/17 row 101). The run engine is mocked so the
 * assertion target is the BRIEF the entity lane hands it (the brief IS the
 * prompt's task text; the model-facing prompt built from it is pinned end to
 * end in `tests/llm/encounterRepopulate.test.ts`).
 *
 * The two properties pinned here are the load-bearing ones:
 *
 * 1. an instruction arrives as EXACTLY ONE appended paragraph — the differential
 *    pin (`with === without + '\n\nAdditional instruction: ' + text`) proves both
 *    that it arrives and that nothing else about the brief moved, without
 *    restating the brief's own literal;
 * 2. with NO instruction the brief is the one the entity lane always sent —
 *    the full-literal byte pin lives in `tests/features/persona-request.test.ts`
 *    (which this change must leave passing untouched).
 */

const { startRunMock, waitForRunStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  waitForRunStatusMock: vi.fn(),
}));

// The engine is faked (this file pins the appended instruction paragraph), but
// the withdrawal predicate is the REAL one — `changeArtifact` reaches
// `runEntityBatch`, which reads it to tell an owner stop from a failure
// (docs/17 row 117).
vi.mock('@/llm/runEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof runEngineModule>();
  return {
    isRunWithdrawn: actual.isRunWithdrawn,
    runNotCompletedReason: actual.runNotCompletedReason,
    runEngine: { on: () => () => undefined, startRun: startRunMock },
    waitForRunStatus: waitForRunStatusMock,
  };
});

const { changeArtifact } = await import('@/features/modules/change-artifact');
const { createArtifact } = await import('@/db/artifactRepo');
const { createCampaign } = await import('@/db/campaignRepo');
const { saveModule } = await import('@/db/moduleRepo');
const { seedBuiltInPersonas } = await import('@/db/seed');
const { createModule } = await import('@/domain');
const { useProgressStore } = await import('@/lib/progress');
const { clearDatabase } = await import('../db/helpers');

async function seedNpc(): Promise<{ npcId: string; moduleId: string }> {
  const campaign = await createCampaign({ name: 'Instruction Campaign', system: 'dnd5e' });
  const module = await saveModule({
    ...createModule({
      campaignId: campaign.id,
      title: 'The Drowned Chapter',
      concept: 'a drowned chapter house',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
    }),
    spine: {
      premise: 'The chapter house sank with its chapter inside.',
      themes: [],
      writerModel: '',
      origin: null,
      partPlan: [{ title: 'Descent', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown: 'The stair sinks toward [[Halvar]], who guards the flooded chapel.',
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: '',
        origin: null,
      },
    ],
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: 'Halvar',
    summary: 'A giant at the stair.',
    body: 'Halvar blocks the stair.',
    data: { appearance: 'Huge', personality: 'Gruff', statBlock: null },
  });
  await seedBuiltInPersonas();
  startRunMock.mockResolvedValue('run-1');
  waitForRunStatusMock.mockResolvedValue({
    status: 'completed',
    resultArtifactId: npc.id,
    errorMessage: '',
  });
  return { npcId: npc.id, moduleId: module.id };
}

function briefs(): string[] {
  return startRunMock.mock.calls.map((call) => {
    const input = call[0] as { brief?: unknown };
    return typeof input.brief === 'string' ? input.brief : '';
  });
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  startRunMock.mockReset();
  waitForRunStatusMock.mockReset();
});

describe('the instruction reaches the entity brief', () => {
  it('arrives as exactly ONE appended paragraph, and the rest of the brief is untouched', async () => {
    const { npcId } = await seedNpc();

    await changeArtifact({ artifactId: npcId });
    const withoutInstruction = briefs()[0] ?? '';
    startRunMock.mockClear();
    await changeArtifact({
      artifactId: npcId,
      instruction: 'Make her a smuggler captain with a grudge against the guild.',
    });
    const withInstruction = briefs()[0] ?? '';

    expect(withoutInstruction).not.toContain('Additional instruction');
    expect(withInstruction).toContain('[[Halvar]]');
    expect(withInstruction).toBe(
      `${withoutInstruction}\n\nAdditional instruction: Make her a smuggler captain with a grudge against the guild.`,
    );
  });

  it('a change targets the EXISTING row (no placement) — and creation still carries it', async () => {
    const { npcId, moduleId } = await seedNpc();

    await changeArtifact({ artifactId: npcId, instruction: 'x' });

    const changeInput = startRunMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(changeInput).toMatchObject({ targetArtifactId: npcId });
    expect(changeInput).not.toHaveProperty('placementModuleId');
    // (the creation path's own placement contract is pinned by
    // tests/features/entity-batch*.test.tsx — this pin only proves the seam
    // did not silently keep a placement on an existing row)
    expect(moduleId).not.toBe('');
  });
});

describe('the brief builder itself', () => {
  it('appends the paragraph last and returns the identical bytes without one', () => {
    const args = ['Halvar', 'The stair sinks.', 'Premise.', 3] as const;
    const plain = buildEntityBrief(...args);

    expect(buildEntityBrief(...args, [], false, 'Make her a smuggler.')).toBe(
      `${plain}\n\nAdditional instruction: Make her a smuggler.`,
    );
    expect(buildEntityBrief(...args, [], false, '')).toBe(plain);
    expect(plain.endsWith('make this entity serve the module text.')).toBe(true);
  });
});
