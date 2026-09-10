import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import {
  assembleModulePartsDocument,
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Id,
} from '@/domain';
import {
  floorRepairTargets,
  ModuleBusyError,
  repairModuleEncounterFloor,
} from '@/llm/moduleGen';
import { bumpStopEpoch } from '@/lib/stopEpoch';
import { clearDatabase } from '../db/helpers';
import { useProgressStore } from '@/lib/progress';

/**
 * "Fix module problems" — the snapshot-scoped repair (docs/08 §M4-B-3).
 *
 * What is pinned here is BEHAVIOR, not implementation: the confirmation's scope
 * comes from the repair seam's own derivation, the rewrite carries the floor
 * repair's instruction (scoped to that one check), a durable version snapshot
 * exists before the write and restores the pre-repair text, a failing rewrite
 * fails LOUDLY and leaves the text byte-identical, and one attempt per part is
 * attempted — never a retry loop. Only the model call and the toasts are mocked.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastSuccessMock = vi.mocked(toastSuccess);

const TEST_MODEL = 'test/fixture-model';

/** The mocked chat result shape (the model is mocked, the seams are real). */
interface ChatReply {
  text: string;
  modelUsed: string;
  fallback: null;
}

const PART_PLAN = [
  { title: 'The Sunken Quarter', levelBand: '1', synopsis: '', levelUpTrigger: '' },
  { title: 'The Drowned Cathedral', levelBand: '2', synopsis: '', levelUpTrigger: '' },
];

/** Module prose well above the 100-char floor, with a findable marker. */
function prose(marker: string, names: string[]): ChatReply {
  return {
    text:
      `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4) +
      `Mentioned here: ${names.map((name) => `[[${name}]]`).join(' and ')}.`,
    modelUsed: 'test-model',
    fallback: null,
  };
}

/** The normalization reply recording every listed name as an encounter. */
function encounterReply(...names: string[]): ChatReply {
  return {
    text: JSON.stringify({
      entities: names.map((name) => ({ name, canonical: name, kind: 'encounter' })),
    }),
    modelUsed: 'test-model',
    fallback: null,
  };
}

/** A module whose part 1 names nothing (the deficient part). */
async function seedShortModule(): Promise<{ campaign: Campaign; moduleId: Id }> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself beneath the water.',
    levelMin: 1,
    levelMax: 2,
    tone: 'eerie',
    sizeDial: 'standard',
  });
  const saved = await saveModule({
    ...draft,
    status: 'failed',
    errorMessage: 'Encounter floor not met',
    entityNamesNormalized: true,
    entityKinds: [{ name: 'Bell Trial', kind: 'encounter', absorbed: [] }],
    spine: moduleSpineSchema.parse({ premise: 'The bell rings.', themes: [], partPlan: PART_PLAN }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: prose('PART-ONE', ['Bell Trial']).text,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: 'PART-TWO: The drowned cathedral waits in the dark, silent and cold. '.repeat(4),
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  return { campaign, moduleId: saved.id };
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  useProgressStore.getState().reset();
  await updateSettings({ defaultChatModel: TEST_MODEL });
});

afterEach(() => {
  chatMock.mockReset();
  useProgressStore.getState().reset();
  vi.restoreAllMocks();
});

describe('floorRepairTargets (the repair scope the confirmation lists)', () => {
  it('names the deficient parts, and every part when names repeat', async () => {
    const { moduleId } = await seedShortModule();

    const short = await getModule(moduleId);
    expect(short).toBeDefined();
    expect(floorRepairTargets(short ?? ({} as never)).map((entry) => entry.planIndex)).toEqual([1]);
  }, 20_000);
});

describe('repairModuleEncounterFloor', () => {
  it('rewrites only the deficient part, snapshots before the write, and returns the module to ready', async () => {
    const { campaign, moduleId } = await seedShortModule();
    const before = await getModule(moduleId);
    const originalPartTwo = before?.parts.find((part) => part.planIndex === 1)?.markdown ?? '';
    chatMock
      .mockResolvedValueOnce(prose('PART-TWO-REPAIRED', ['Flood Trial']))
      .mockResolvedValueOnce(encounterReply('Bell Trial', 'Flood Trial'));

    const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1]);

    expect(outcome.attempted.map((entry) => entry.planIndex)).toEqual([1]);
    expect(outcome.rewritten.map((entry) => entry.planIndex)).toEqual([1]);
    expect(outcome.failed).toEqual([]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.met).toBe(true);
    expect(outcome.stopped).toBe(false);
    const after = await getModule(moduleId);
    expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toContain(
      'PART-TWO-REPAIRED',
    );
    // Part 1 was NOT touched (the rewrite is scoped to the failing check's part).
    expect(after?.parts.find((part) => part.planIndex === 0)?.markdown).toContain('PART-ONE');
    expect(after?.status).toBe('ready');
    expect(after?.errorMessage).toBe('');
    // The instruction is the floor repair's own — scoped to that check.
    const repairPrompt = userMessagesOf(0).join('\n');
    expect(repairPrompt).toContain('Encounter floor repair');
    expect(repairPrompt).toContain('keep the part');
    // One model call for the rewrite + one for the existing normalization pass
    // (the new encounter has no recorded kind until it runs) — and NO retry.
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('Fixed the encounter floor'));
    expect(originalPartTwo).not.toContain('PART-TWO-REPAIRED');
  }, 30_000);

  it('takes a durable snapshot BEFORE the write, and restoring it brings the pre-repair text back', async () => {
    const { campaign, moduleId } = await seedShortModule();
    const before = await getModule(moduleId);
    const preRepairDoc = assembleModulePartsDocument({
      partPlan: before?.spine?.partPlan ?? [],
      parts: before?.parts ?? [],
    }).document;
    chatMock
      .mockResolvedValueOnce(prose('PART-TWO-REPAIRED', ['Flood Trial']))
      .mockResolvedValueOnce(encounterReply('Bell Trial', 'Flood Trial'));

    await repairModuleEncounterFloor(moduleId, campaign, [1]);

    const versions = await listModuleVersions(moduleId);
    const repairVersion = versions.find((version) => version.label.includes('Fix module problems'));
    expect(repairVersion?.source).toBe('generation');
    // Byte-exact pre-change document, in the ONE parts-document format — the
    // same seam the Versions menu restores from.
    expect(repairVersion?.docText).toBe(preRepairDoc);
    expect(repairVersion?.docText).toContain('PART-TWO: The drowned cathedral');
    // The snapshot is the PRE-state: the repair's result is not in it.
    expect(repairVersion?.docText).not.toContain('PART-TWO-REPAIRED');
    // The name-normalization pass took its own snapshot, exactly as it does
    // inside every parts pass (it is a separate AI change of the same doc).
    expect(versions.map((version) => version.source)).toContain('normalization');
  }, 30_000);

  it('fails LOUDLY and writes nothing when the rewrite call fails', async () => {
    const { campaign, moduleId } = await seedShortModule();
    const before = await getModule(moduleId);
    const preRepair = before?.parts.find((part) => part.planIndex === 1);
    chatMock.mockRejectedValueOnce(new Error('provider exploded mid-rewrite'));

    const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1]);

    expect(outcome.failed.map((entry) => entry.planIndex)).toEqual([1]);
    expect(outcome.rewritten).toEqual([]);
    expect(outcome.met).toBe(false);
    expect(outcome.remaining.map((entry) => entry.planIndex)).toEqual([1]);
    const after = await getModule(moduleId);
    const part = after?.parts.find((entry) => entry.planIndex === 1);
    // The pre-repair prose is back, byte-identical, with its own status.
    expect(part?.markdown).toBe(preRepair?.markdown);
    expect(part?.status).toBe('ready');
    expect(part?.errorMessage).toBe('');
    // The module is left failed with the floor's own verdict named loudly.
    expect(after?.status).toBe('failed');
    const failedToast = toastErrorMock.mock.calls.find((call) =>
      call[0].includes('could not be rewritten'),
    );
    expect(failedToast).toBeDefined();
    expect(failedToast?.[0]).toContain('their text was left as it was');
    expect(toastErrorMock).toHaveBeenCalledWith(
      'The module still falls short of its encounter floor',
      expect.any(Error),
    );
    // ONE attempt: no retry, and the normalization pass never ran (nothing was
    // rewritten).
    expect(chatMock).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('reports a still-short floor loudly after the attempt, keeping what was written', async () => {
    const { campaign, moduleId } = await seedShortModule();
    // The rewrite lands prose that still names no encounter.
    chatMock
      .mockResolvedValueOnce({
        text: 'PART-TWO-REPAIRED: still no fight here, only fog and waiting. '.repeat(4),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce(encounterReply('Bell Trial'));

    const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1]);

    expect(outcome.met).toBe(false);
    expect(outcome.rewritten.map((entry) => entry.planIndex)).toEqual([1]);
    expect(outcome.remaining.map((entry) => entry.planIndex)).toEqual([1]);
    const after = await getModule(moduleId);
    expect(after?.status).toBe('failed');
    expect(after?.errorMessage).toContain('Encounter floor not met');
    // The rewrite is NOT rolled back (the version snapshot is the undo) — but
    // the failure is loud and names the one-attempt bound.
    expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toContain(
      'PART-TWO-REPAIRED',
    );
    const loud = toastErrorMock.mock.calls.find(
      (call) => call[0] === 'The module still falls short of its encounter floor',
    );
    expect(loud).toBeDefined();
    expect((loud?.[1] as Error).message).toContain('One rewrite attempt per part was made');
    expect(toastSuccessMock).not.toHaveBeenCalled();
  }, 30_000);

  it('skips a part that is no longer short (the text changed while the confirmation was open)', async () => {
    const { campaign, moduleId } = await seedShortModule();
    // The owner fixed part 1 by hand (the one part-text save path stamps
    // `ready`) and the module is no longer short of anything.
    await patchModule(moduleId, {
      status: 'ready',
      errorMessage: '',
      entityKinds: [
        { name: 'Bell Trial', kind: 'encounter', absorbed: [] },
        { name: 'Flood Trial', kind: 'encounter', absorbed: [] },
      ],
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          markdown: prose('PART-ONE', ['Bell Trial']).text,
          status: 'ready',
          errorMessage: '',
          edited: false,
        }),
        modulePartSchema.parse({
          planIndex: 1,
          markdown: prose('PART-TWO', ['Flood Trial']).text,
          status: 'ready',
          errorMessage: '',
          edited: true,
        }),
      ],
    });

    const beforeCall = await getModule(moduleId);
    const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1]);

    expect(outcome.attempted).toEqual([]);
    expect(outcome.skipped.map((entry) => entry.planIndex)).toEqual([1]);
    expect(outcome.met).toBe(true);
    // No model call, no rewrite, no snapshot of a change that never happened,
    // and not one byte written to the row.
    expect(chatMock).not.toHaveBeenCalled();
    expect(await listModuleVersions(moduleId)).toHaveLength(0);
    const after = await getModule(moduleId);
    expect(after?.parts.find((part) => part.planIndex === 1)?.markdown).toContain('PART-TWO');
    expect(after?.status).toBe('ready');
    // Not one write: the row is untouched, timestamp included.
    expect(after?.updatedAt).toBe(beforeCall?.updatedAt);
  }, 30_000);

  it('stops between parts when a Stop all lands, and writes nothing further', async () => {
    const { campaign, moduleId } = await seedShortModule();
    // The first rewrite itself trips the stop (the owner pressing Stop all
    // while the model is writing): the run must not start the next part.
    chatMock.mockImplementationOnce(() => {
      bumpStopEpoch();
      return Promise.resolve(prose('PART-TWO-REPAIRED', ['Flood Trial']));
    });
    // A second part is requested too, so "did not start its next unit" is real.
    await patchModule(moduleId, {
      spine: moduleSpineSchema.parse({
        premise: 'The bell rings.',
        themes: [],
        partPlan: [
          ...PART_PLAN,
          { title: 'The Bell Tower', levelBand: '2', synopsis: '', levelUpTrigger: '' },
        ],
      }),
    });

    const outcome = await repairModuleEncounterFloor(moduleId, campaign, [1, 2]);

    expect(outcome.stopped).toBe(true);
    expect(outcome.attempted.map((entry) => entry.planIndex)).toEqual([1]);
    expect(chatMock).toHaveBeenCalledTimes(1);
    // A stopped run reaches no verdict about the text: the row keeps the status
    // it had at entry.
    const after = await getModule(moduleId);
    expect(after?.status).toBe('failed');
    expect(after?.errorMessage).toBe('Encounter floor not met');
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);

  it('refuses a second run while this module already has one in flight', async () => {
    const { campaign, moduleId } = await seedShortModule();
    let release: (() => void) | undefined;
    chatMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(prose('PART-TWO-REPAIRED', ['Flood Trial']));
          };
        }),
    );
    chatMock.mockResolvedValueOnce(encounterReply('Bell Trial', 'Flood Trial'));

    const first = repairModuleEncounterFloor(moduleId, campaign, [1]);
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalledTimes(1);
    });

    await expect(repairModuleEncounterFloor(moduleId, campaign, [1])).rejects.toBeInstanceOf(
      ModuleBusyError,
    );

    release?.();
    const outcome = await first;
    expect(outcome.met).toBe(true);
  }, 30_000);

  it('is a no-op for an empty request', async () => {
    const { campaign, moduleId } = await seedShortModule();

    const outcome = await repairModuleEncounterFloor(moduleId, campaign, []);

    expect(outcome).toEqual({
      attempted: [],
      rewritten: [],
      failed: [],
      skipped: [],
      remaining: [],
      met: false,
      stopped: false,
    });
    expect(chatMock).not.toHaveBeenCalled();
  }, 20_000);
});

/** The user-message text of the Nth chat call (the prompt is the behavior). */
function userMessagesOf(index: number): string[] {
  const call = chatMock.mock.calls[index];
  if (call === undefined) return [];
  return call[0].map((message) =>
    typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
  );
}
