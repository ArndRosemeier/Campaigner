import 'fake-indexeddb/auto';

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule, getModule, patchModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import { createModule, modulePartSchema, moduleSpineSchema } from '@/domain';
import { stopAllGenerations } from '@/features/progress/stop-all-generations';
import {
  cancelCanvasGenerations,
  isModuleGenerationClaimed,
  registerCanvasAbort,
} from '@/llm/canvasBusy';
import { normalizeModuleEntityNames } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * The canvas + normalization surfaces of Stop all (owner report: "Stop all
 * should stop all generations, but it only stops the current type loop").
 *
 * Canvas AI turns stream straight from `canvasChat`/`canvasRefine`, so they
 * have no run row for the sweep to find; `llm/canvasBusy` publishes one abort
 * handle per live turn and the sweep drives it. The two properties that
 * matter: the sweep's abort reaches the LIVE model call, and it reaches the
 * caller's own controller too (that is what marks the partial reply
 * 'aborted' in place instead of toasting an error).
 */

vi.mock('@/llm/moduleGen', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, cancelModuleGen: vi.fn() };
});

vi.mock('@/llm/imageGen', () => ({ generateImages: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));
vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  toastErrorMock.mockReset();
  await updateSettings({ imagesEnabled: true, imageModel: 'test-image-model' });
});

describe('the canvas abort registry', () => {
  it('aborts the live turn AND the caller controller the sweep cannot see', () => {
    const caller = new AbortController();
    const handle = registerCanvasAbort('module-1', caller);

    expect(handle.signal.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);

    const cancelled = cancelCanvasGenerations();
    expect(cancelled).toEqual(['module-1']);
    // The turn's own model call is cancelled…
    expect(handle.signal.aborted).toBe(true);
    // …and so is the controller the UI checks to decide "the user stopped
    // this — mark the partial reply 'aborted', never toast an error".
    expect(caller.signal.aborted).toBe(true);
    handle.releaseHandle();
    expect(cancelCanvasGenerations()).toEqual([]);
  });

  it('relays the caller controller\u2019s own abort to the turn signal', () => {
    const caller = new AbortController();
    const handle = registerCanvasAbort('module-2', caller);

    caller.abort();

    expect(handle.signal.aborted).toBe(true);
    handle.releaseHandle();
  });

  it('reports nothing for a turn that already released its handle', () => {
    const caller = new AbortController();
    const handle = registerCanvasAbort('module-3', caller);
    handle.releaseHandle();

    expect(cancelCanvasGenerations()).toEqual([]);
    expect(isModuleGenerationClaimed('module-3')).toBe(false);
  });
});

describe('stopAllGenerations covers canvas turns', () => {
  it('counts a live canvas turn as a stopped unit and aborts it', async () => {
    const caller = new AbortController();
    const handle = registerCanvasAbort('canvas-module', caller);

    const result = await stopAllGenerations();

    // `reconciled` is the second, honest count (docs/17 row 110): rows that
    // only CLAIMED to be generating and were failed loudly instead — never
    // counted as work this sweep stopped.
    expect(result).toEqual({ stopped: 1, reconciled: 0 });
    expect(handle.signal.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(true);
    handle.releaseHandle();
  });
});

describe('the forge normalization pass carries the stop signal', () => {
  async function seedModule(): Promise<string> {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const module = await saveModule({
      ...createModule({
        campaignId: campaign.id,
        title: 'Ember Crypt',
        concept: 'A drowned crypt beneath the harbor.',
        levelMin: 1,
        levelMax: 4,
        sizeDial: 'sketch',
      }),
      status: 'ready',
      spine: moduleSpineSchema.parse({
        premise: 'The gate of [[Ember Crypt]] opens at dusk.',
        themes: [],
        partPlan: [
          {
            title: 'The Tide Gate',
            levelBand: '1–4',
            synopsis: 'The party meets [[Kael]] at the sealed gate.',
            levelUpTrigger: 'The gate opens.',
          },
        ],
      }),
      parts: [
        modulePartSchema.parse({
          planIndex: 0,
          status: 'ready',
          markdown: '## The Tide Gate\n\n[[Kael]] watches the gate and counts every visitor.',
          edited: false,
          errorMessage: '',
        }),
      ],
    });
    return module.id;
  }

  it('aborts the normalization chat call when the signal fires (no call outlives a stop)', async () => {
    const moduleId = await seedModule();
    const controller = new AbortController();
    // The model call hangs until its signal aborts — exactly a stream a stop
    // must cut off.
    chatMock.mockImplementation((_messages, opts) => {
      const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
      if (signal === undefined) return Promise.reject(new Error('no signal passed'));
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const call = normalizeModuleEntityNames(moduleId, controller.signal);
    await waitFor(() => {
      expect(chatMock).toHaveBeenCalledTimes(1);
    });
    const carried = (chatMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined)?.signal;
    expect(carried).toBe(controller.signal);

    // The stop aborts the pass's own controller (what the sweep drives):
    // the call settles, nothing more is issued, and the pass rejects into
    // the caller's cancel path.
    controller.abort();
    await expect(call).rejects.toThrow();
    expect(chatMock).toHaveBeenCalledTimes(1);
    // A stop is not a normalization failure (no toast, no recorded error).
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);

  it('records a normalization failure loudly for a genuine model failure', async () => {
    const moduleId = await seedModule();
    chatMock.mockRejectedValue(new Error('the provider refused the request'));

    await normalizeModuleEntityNames(moduleId);

    expect(toastErrorMock).toHaveBeenCalled();
    const row = await getModule(moduleId);
    expect(row?.entityNamesNormalized).toBe(false);
    expect(row?.entityNormalizationError).toContain('the provider refused the request');
  }, 30_000);

  it('does not paint the failure state over a stopped pass', async () => {
    const moduleId = await seedModule();
    const controller = new AbortController();
    chatMock.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });

    await expect(normalizeModuleEntityNames(moduleId, controller.signal)).rejects.toThrow();

    // A user stop is not a normalization failure: no failure toast, no error
    // recorded — the quiet cancel path owns the rewind.
    expect(toastErrorMock).not.toHaveBeenCalled();
    const row = await getModule(moduleId);
    expect(row?.entityNormalizationError).toBe('');
    // Still resumable: the parts are untouched.
    expect(row?.parts).toHaveLength(1);
    expect(row?.status).toBe('ready');
    void patchModule;
  }, 30_000);
});
