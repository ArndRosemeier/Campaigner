import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  followUpCallLabel,
  sendCanvasChatMessage,
  type CanvasChatChangeExecutor,
  type CanvasChatTurnInput,
} from '@/llm/canvasChat';
import { createModule, type Id } from '@/domain';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { useProgressStore, type ProgressJob } from '@/lib/progress';
import { notePageResumed, notePageSuspended } from '@/lib/pageLiveness';
import {
  STREAM_PAUSED_DETAIL,
  streamDetailReporter,
  withStreamProgress,
} from '@/llm/streamProgress';
import type { ChatOptions } from '@/llm/openrouter';
import { CODE, filesWith } from '../helpers/sourceCode';
import { clearDatabase } from '../db/helpers';

/**
 * docs/17 row 412 — the canvas chat's waiting is VISIBLE. The owner approved an
 * advisor card and the chat showed nothing for 20+ minutes; verbatim: *"the most
 * frustrating part is that waiting is not visible in any way … If there are
 * multiple calls involved i should be able to see each of them."*
 *
 * Pinned here:
 *  (a) each model call of a chat turn is its OWN dock entry (reply, follow-up),
 *      naming the model, and every entry is gone once the turn settles — on
 *      success AND on failure;
 *  (b) the ONE stream reporter says so when the page is suspended (the
 *      watchdog clock pauses then), names a fallback switch, and keeps the
 *      module forge's wording byte-identical;
 *  (c) the bubble callbacks receive CUMULATIVE text (they used to receive each
 *      bare token, so the bubble showed only the last chunk and a failed
 *      follow-up kept only its last token);
 *  (d) exactly ONE stream reporter exists in `src/`.
 */

vi.mock('@/llm/openrouter', async (importOriginal) =>
  (await import('../helpers/openrouterMock')).openrouterMock(importOriginal, { chat: vi.fn() }),
);

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

let moduleId: Id = '';

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  chatMock.mockReset();
  const campaign = await createCampaign({ name: 'Ember', description: 'The ember war.', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
  });
  await saveModule({ ...draft, createdAt: 2 });
  moduleId = draft.id;
});

afterEach(() => {
  notePageResumed();
  useProgressStore.getState().reset();
});

const CHANGE_REPLY =
  'On it. <change><name>Keeper Ilse</name><instruction>make her older</instruction></change>';

const executor: CanvasChatChangeExecutor = () =>
  Promise.resolve({ status: 'changed', artifactId: null, kind: 'npc', detail: 'done' });

function baseInput(overrides: Partial<CanvasChatTurnInput> = {}): CanvasChatTurnInput {
  return {
    moduleId,
    document: '',
    instruction: 'make Ilse older',
    history: [],
    model: 'test/model-a',
    turn: new AbortController(),
    executeChange: executor,
    reportChange: () => undefined,
    ...overrides,
  };
}

function chatJobs(): ProgressJob[] {
  return useProgressStore.getState().jobs.filter((job) => job.id.startsWith('chat-call:'));
}

describe('(a) every chat-turn call is its own dock entry', () => {
  it('the reply and the follow-up are DISTINCT entries naming the model, gone when the turn settles', async () => {
    const seen: { label: string; detail: string }[][] = [];
    chatMock.mockImplementationOnce(() => {
      seen.push(chatJobs().map(({ label, detail }) => ({ label, detail })));
      return Promise.resolve({ text: CHANGE_REPLY, modelUsed: 'test/model-a', fallback: null });
    });
    chatMock.mockImplementationOnce(() => {
      seen.push(chatJobs().map(({ label, detail }) => ({ label, detail })));
      return Promise.resolve({ text: 'Done — she is older.', modelUsed: 'test/model-a', fallback: null });
    });
    const result = await sendCanvasChatMessage(baseInput());
    expect(result.changes?.status).toBe('ok');
    expect(seen).toEqual([
      [{ label: 'Chat reply', detail: 'Model: test/model-a — waiting for the first bytes…' }],
      [
        {
          label: 'Chat follow-up (after 1 change)',
          detail: 'Model: test/model-a — waiting for the first bytes…',
        },
      ],
    ]);
    expect(chatJobs()).toEqual([]);
  });

  it('a FAILED follow-up still removes its entry (the failure rides the result, never only the dock)', async () => {
    chatMock.mockResolvedValueOnce({ text: CHANGE_REPLY, modelUsed: 'm', fallback: null });
    chatMock.mockImplementationOnce(() => {
      expect(chatJobs().map((job) => job.label)).toEqual(['Chat follow-up (after 1 change)']);
      return Promise.reject(new Error('provider exploded'));
    });
    const result = await sendCanvasChatMessage(baseInput());
    expect(result.details?.status).toBe('failed');
    expect(result.changes).toMatchObject({ status: 'failed', error: 'provider exploded' });
    expect(chatJobs()).toEqual([]);
  });

  it('a FAILED reply throws to the caller and removes its entry', async () => {
    chatMock.mockRejectedValueOnce(new Error('no key'));
    await expect(sendCanvasChatMessage(baseInput())).rejects.toThrow('no key');
    expect(chatJobs()).toEqual([]);
  });

  it('the follow-up label names what it carries back', () => {
    expect(followUpCallLabel(0, 2)).toBe('Chat follow-up (after 2 changes)');
    expect(followUpCallLabel(1, 0)).toBe('Chat follow-up (after 1 details request)');
    expect(followUpCallLabel(2, 1)).toBe('Chat follow-up (after 1 change and 2 details requests)');
  });

  it('the chat call wires the live phase AND the fallback into its entry', async () => {
    chatMock.mockImplementationOnce((_messages, options: ChatOptions) => {
      options.onFallback?.({ from: 'test/model-a', to: 'test/model-b', reason: 'congestion' });
      expect(chatJobs()[0]?.detail).toBe(
        'Model: test/model-a → fallback test/model-b — test/model-a was congested; retrying on the fallback model test/model-b…',
      );
      return Promise.resolve({ text: 'Plain answer.', modelUsed: 'test/model-b', fallback: null });
    });
    await sendCanvasChatMessage(baseInput());
    expect(chatJobs()).toEqual([]);
  });
});

describe('(a) the adversarial review names each of its two calls on its entry', () => {
  it('critique, then edit — each with the model, on the caller-owned entry', async () => {
    const { runAdversarialPass } = await import('@/llm/adversarialPass');
    const details: string[] = [];
    useProgressStore.getState().start('review', 'Reviewing premise');
    chatMock.mockImplementationOnce(() => {
      details.push(useProgressStore.getState().jobs[0]?.detail ?? '');
      return Promise.resolve({
        text: JSON.stringify({
          issues: [{ kind: 'fun', severity: 'major', message: 'Flat.', where: 'opening' }],
        }),
        modelUsed: 'm',
        fallback: null,
      });
    });
    chatMock.mockImplementationOnce(() => {
      details.push(useProgressStore.getState().jobs[0]?.detail ?? '');
      return Promise.resolve({
        text: JSON.stringify({ replacement: 'A sharper premise.' }),
        modelUsed: 'm',
        fallback: null,
      });
    });
    await runAdversarialPass({
      moduleId,
      target: { kind: 'premise' },
      text: 'The premise.',
      progressJobId: 'review',
    });
    expect(details).toHaveLength(2);
    expect(details[0]).toMatch(/^Critique of the premise · Model: \S+ — waiting for the first bytes…$/);
    expect(details[1]).toMatch(/^Edit of the premise · Model: \S+ — waiting for the first bytes…$/);
  });
});

describe('(b) the ONE stream reporter', () => {
  function detailAfter(act: (reporter: ReturnType<typeof streamDetailReporter>) => void): string {
    useProgressStore.getState().start('job', 'Label', 'initial');
    act(streamDetailReporter('job', 'Base'));
    return useProgressStore.getState().jobs.find((job) => job.id === 'job')?.detail ?? '';
  }

  it('says PAUSED while the browser reports the tab hidden', () => {
    notePageSuspended();
    const detail = detailAfter((reporter) => {
      reporter.onActivity({ elapsedMs: 12_000, receivedChars: 0, phase: 'thinking' });
    });
    expect(detail).toBe(`Base — ${STREAM_PAUSED_DETAIL} (12s of active time so far).`);
    expect(STREAM_PAUSED_DETAIL).toContain('the browser froze this tab');
  });

  it('keeps the module forge wording byte-identical (thinking / waiting / chars)', () => {
    expect(
      detailAfter((reporter) => {
        reporter.onActivity({ elapsedMs: 7_400, receivedChars: 0, phase: 'thinking' });
      }),
    ).toBe(
      'Base — the model is thinking (7s). Big design asks routinely take several minutes of thinking before the first words arrive — this is normal, not a hang.',
    );
    expect(
      detailAfter((reporter) => {
        reporter.onActivity({ elapsedMs: 6_000, receivedChars: 0, phase: 'waiting' });
      }),
    ).toBe(
      'Base — no answer yet (6s). The request may be queued at the provider; the first bytes can take minutes.',
    );
    expect(
      detailAfter((reporter) => {
        reporter.onToken('abcde');
      }),
    ).toBe('Base — 5 chars received');
  });

  it('withStreamProgress finishes its entry when the call throws', async () => {
    await expect(
      withStreamProgress({ jobId: 'w', label: 'Call', model: 'm' }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(useProgressStore.getState().jobs).toEqual([]);
  });
});

describe('(c) the bubble callbacks receive CUMULATIVE text', () => {
  it('onDelta and onFollowUpDelta get text-so-far, not the bare token', async () => {
    chatMock.mockImplementationOnce((_messages, options: ChatOptions) => {
      options.onToken?.('On ');
      options.onToken?.('it. ');
      options.onToken?.('<change>');
      return Promise.resolve({ text: CHANGE_REPLY, modelUsed: 'm', fallback: null });
    });
    chatMock.mockImplementationOnce((_messages, options: ChatOptions) => {
      options.onToken?.('Done');
      options.onToken?.(' now.');
      return Promise.resolve({ text: 'Done now.', modelUsed: 'm', fallback: null });
    });
    const deltas: string[] = [];
    const followUps: string[] = [];
    await sendCanvasChatMessage(
      baseInput({
        onDelta: (soFar) => deltas.push(soFar),
        onFollowUpDelta: (soFar) => followUps.push(soFar),
      }),
    );
    expect(deltas).toEqual(['On ', 'On it. ', 'On it. <change>']);
    expect(followUps).toEqual(['Done', 'Done now.']);
  });

  it('a failed follow-up keeps ALL it streamed, and a fallback restart clears the failed attempt', async () => {
    chatMock.mockResolvedValueOnce({ text: CHANGE_REPLY, modelUsed: 'm', fallback: null });
    chatMock.mockImplementationOnce((_messages, options: ChatOptions) => {
      options.onToken?.('lost ');
      options.onReset?.();
      options.onToken?.('Half ');
      options.onToken?.('written');
      return Promise.reject(new Error('stream died'));
    });
    const followUps: string[] = [];
    const result = await sendCanvasChatMessage(
      baseInput({ onFollowUpDelta: (soFar) => followUps.push(soFar) }),
    );
    expect(followUps).toEqual(['lost ', '', 'Half ', 'Half written']);
    expect(result.details).toMatchObject({ status: 'failed', raw: 'Half written' });
  });
});

describe('(d) exactly ONE stream reporter', () => {
  it('only llm/streamProgress defines the reporter and renders its phase wording', () => {
    expect(filesWith('function streamDetailReporter(')).toEqual(['src/llm/streamProgress.ts']);
    expect(filesWith('chars received')).toEqual(['src/llm/streamProgress.ts']);
    expect(filesWith('the model is thinking (')).toEqual(['src/llm/streamProgress.ts']);
    expect(CODE['src/llm/moduleGen.ts']).toContain("from '@/llm/streamProgress'");
    // Every chat-turn call goes through the one entry wrapper (reply + follow-up).
    expect(CODE['src/llm/canvasChat.ts']?.split('withStreamProgress(').length).toBe(3);
  });
});
