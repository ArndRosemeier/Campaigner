import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Id,
} from '@/domain';
import { hasLiveModuleGen, runParts } from '@/llm/moduleGen';
import {
  INTERRUPTED_MODULE_GEN_MESSAGE,
  reconcileInterruptedModuleGen,
  reconcileInterruptedModuleGens,
} from '@/llm/moduleGenReconcile';
import { moduleGenLockName } from '@/lib/generationLocks';
import { clearDatabase } from '../db/helpers';

/**
 * Interrupted module-generation reconciliation (docs/17 row 110, docs/18 §2.2).
 *
 * The launched defect: a module row left at `status: 'generating'` by a
 * reloaded/discarded tab had NO reconciliation anywhere — a permanent spinner,
 * a Stop button that was a silent no-op, every retry affordance gated on
 * `!busy`, and "Stop all generations" counting the dead row as stopped. The
 * status is a LEASE, so the fix is a liveness guard plus a LOUD failed state
 * whose part slots rewind, which is what re-opens the EXISTING recovery path.
 *
 * Both guard directions are pinned: a row with a live pass in THIS page is
 * never touched, and a row whose generation lock another tab holds is never
 * touched either.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const PART_ZERO_TEXT = 'The party reaches the [[Flooded Crypt]] and bargains.';

const SPINE = moduleSpineSchema.parse({
  premise: 'A drowned vault under the mill.',
  themes: ['bargains'],
  partPlan: [
    { title: 'The Mill', levelBand: '1', synopsis: 'Arrival.', levelUpTrigger: 'Opened.' },
    { title: 'The Vault', levelBand: '2', synopsis: 'Descent.', levelUpTrigger: 'Answered.' },
  ],
});

/** A module whose LAST part is mid-write and whose first part is finished. */
async function seedInterruptedModule(): Promise<{ campaign: Campaign; moduleId: Id }> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
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
    spine: SPINE,
    entityKinds: [
      { name: 'Flooded Crypt', kind: 'encounter', absorbed: [] },
      { name: 'Sunken Trial', kind: 'encounter', absorbed: [] },
    ],
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: PART_ZERO_TEXT,
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: '',
        status: 'generating',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  return { campaign, moduleId: saved.id };
}

/** Holds a chat call open until its abort signal fires (the stop-all recipe). */
function holdUntilAborted(_messages: unknown, opts: unknown): Promise<never> {
  const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
  if (signal === undefined) return Promise.reject(new Error('no abort signal passed'));
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reconcileInterruptedModuleGen', () => {
  it('fails an unclaimed generating row LOUDLY and rewinds only its unfinished part slots', async () => {
    const { moduleId } = await seedInterruptedModule();

    expect(await reconcileInterruptedModuleGen(moduleId)).toBe(true);

    const row = await getModule(moduleId);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toBe(INTERRUPTED_MODULE_GEN_MESSAGE);
    // The named sentence says what happened AND which control recovers.
    expect(row?.errorMessage).toContain('"Resume module generation"');
    // The slot that was mid-write is back to 'pending' — the status
    // `generateMissingParts` re-runs; the finished part is untouched.
    const zero = row?.parts.find((part) => part.planIndex === 0);
    const one = row?.parts.find((part) => part.planIndex === 1);
    expect(zero?.status).toBe('ready');
    expect(zero?.markdown).toBe(PART_ZERO_TEXT);
    expect(one?.status).toBe('pending');
    expect(one?.errorMessage).toBe('');
  });

  it('is idempotent: a second pass writes nothing at all', async () => {
    const { moduleId } = await seedInterruptedModule();
    expect(await reconcileInterruptedModuleGen(moduleId)).toBe(true);
    const after = await getModule(moduleId);

    expect(await reconcileInterruptedModuleGen(moduleId)).toBe(false);

    expect(await getModule(moduleId)).toEqual(after);
  });

  it('never touches a module a live parts pass owns in THIS page (the guard)', async () => {
    const { campaign, moduleId } = await seedInterruptedModule();
    chatMock.mockImplementation(holdUntilAborted);
    // A REAL held pass: `runParts` registers the controller, marks the module
    // 'generating' and parks in the model call.
    void runParts(moduleId, campaign, { planIndexes: [1] }).catch(() => undefined);
    await vi.waitFor(() => {
      expect(hasLiveModuleGen(moduleId)).toBe(true);
    });
    const live = await getModule(moduleId);
    expect(live?.status).toBe('generating');

    expect(await reconcileInterruptedModuleGen(moduleId)).toBe(false);
    expect(await reconcileInterruptedModuleGens()).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();

    const still = await getModule(moduleId);
    expect(still?.status).toBe('generating');
    expect(still?.errorMessage).not.toBe(INTERRUPTED_MODULE_GEN_MESSAGE);
    expect(still?.parts.find((part) => part.planIndex === 1)?.status).toBe('generating');
  }, 30_000);

  it('never touches a module another tab is generating (the held generation lock)', async () => {
    const { moduleId } = await seedInterruptedModule();
    const held: { name: string }[] = [{ name: moduleGenLockName(moduleId) }];
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback(),
        query: () => Promise.resolve({ held, pending: [] }),
      },
    });
    expect(hasLiveModuleGen(moduleId)).toBe(false);

    expect(await reconcileInterruptedModuleGen(moduleId)).toBe(false);
    expect((await getModule(moduleId))?.status).toBe('generating');

    // …and with the lock released the very same row IS reconciled: the lock is
    // the only reason it survived.
    held.length = 0;
    expect(await reconcileInterruptedModuleGen(moduleId)).toBe(true);
    expect((await getModule(moduleId))?.status).toBe('failed');
  });

  it('reports a batch loudly, and stays silent when asked to', async () => {
    const first = await seedInterruptedModule();
    const second = await seedInterruptedModule();

    const reconciled = await reconcileInterruptedModuleGens();
    expect(reconciled.sort()).toEqual([first.moduleId, second.moduleId].sort());
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(String(toastErrorMock.mock.calls[0]?.[0])).toContain('Interrupted 2 module generations');

    toastErrorMock.mockClear();
    await patchModule(first.moduleId, { status: 'generating' });
    const quiet = await reconcileInterruptedModuleGens([first.moduleId], { notify: false });
    expect(quiet).toEqual([first.moduleId]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('re-opens the EXISTING recovery path: the rewound part is written by generateMissingParts', async () => {
    const { campaign, moduleId } = await seedInterruptedModule();
    const NEW_PART_TEXT = [
      'The vault door is the [[Sunken Trial]], and it answers once when the party knocks.',
      '',
      'The keeper of the mill left three rules on the lintel: pay in salt, never count the bells',
      'aloud, and leave the lamp burning while the water climbs the stair.',
    ].join('\n');
    chatMock.mockImplementation((_messages, opts) => {
      const format = (opts as { responseFormat?: { name?: string } }).responseFormat;
      if (format?.name === 'entity-normalization') {
        return Promise.resolve({
          text: JSON.stringify({
            entities: [
              { name: 'Flooded Crypt', canonical: 'Flooded Crypt', kind: 'encounter' },
              { name: 'Sunken Trial', canonical: 'Sunken Trial', kind: 'encounter' },
            ],
          }),
          modelUsed: 'test-model',
          fallback: null,
        });
      }
      return Promise.resolve({ text: NEW_PART_TEXT, modelUsed: 'test-model', fallback: null });
    });

    await reconcileInterruptedModuleGen(moduleId);
    const { generateMissingParts } = await import('@/llm/moduleGen');
    await generateMissingParts(moduleId, campaign);

    const row = await getModule(moduleId);
    // The part the reconcile rewound was written; the finished part was not
    // re-run (the pass is scoped to the non-ready slots).
    expect(row?.parts.find((part) => part.planIndex === 1)?.markdown).toBe(NEW_PART_TEXT);
    expect(row?.parts.find((part) => part.planIndex === 0)?.markdown).toBe(PART_ZERO_TEXT);
    // One part call — the recovery wrote exactly what was missing.
    const partCalls = chatMock.mock.calls.filter(
      (call) => (call[1] as { responseFormat?: unknown }).responseFormat === undefined,
    );
    expect(partCalls).toHaveLength(1);
    expect(row?.status).toBe('ready');
  }, 30_000);
});
