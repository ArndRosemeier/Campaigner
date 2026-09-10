import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { JSX } from 'react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { modulePath } from '@/app/routes';
import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { patchModule, saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Id,
} from '@/domain';
import { streamTails } from '@/features/modules/streamTails';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Reader stream churn (owner report: "scrolling this is slow and jumpy, as if
 * it's getting rendered fresh and complete for each tick") — the STRUCTURAL
 * pins for the cause, not a timing measurement.
 *
 * Measured before the fix (dev server, Chrome 151, 12 parts × ~4 KB): every
 * streaming delta re-rendered `ModuleReaderPage`, re-parsing EVERY part's
 * markdown plus the premise — 7 markdown parses per token tick in a
 * 6-part module, 13.6 s of main-thread task for 200 tokens (one 50–115 ms
 * long task per token), and scrolling during generation at 51 ms median
 * frames against 16.8 ms while idle.
 *
 * What jsdom CAN prove (and these tests do): render churn — which component
 * re-rendered, and whether a part's markdown tree was rebuilt. What it CANNOT
 * prove (docs/08-TESTING.md §1: jsdom does no layout, no paint, no scrolling):
 * that scrolling is now smooth. The scroll numbers above are browser
 * measurements, not jsdom ones.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// `react-markdown` is wrapped (NOT stubbed): the real renderer still runs, so
// the rendered reader is byte-identical, while each invocation of the wrapper
// is one markdown PARSE — the structural unit the churn is made of. The part
// a parse belongs to is read from the `[PART-n]` marker in the markdown, so
// "which parts re-parsed" is attributable per part.
const parsesByPart = new Map<string, number>();

vi.mock('react-markdown', async (importOriginal) => {
  const actual = await importOriginal<{
    default: (props: Record<string, unknown>) => JSX.Element;
    defaultUrlTransform: unknown;
  }>();
  const RealMarkdown = actual.default;
  function CountingMarkdown(props: { children?: unknown }): JSX.Element {
    const value = typeof props.children === 'string' ? props.children : '';
    const marker = /\[PART-(\d+)\]/.exec(value);
    const key = marker?.[1] === undefined ? 'premise' : `part-${marker[1]}`;
    parsesByPart.set(key, (parsesByPart.get(key) ?? 0) + 1);
    return <RealMarkdown {...props} />;
  }
  return { ...actual, default: CountingMarkdown };
});

// The emitter itself stays REAL — the tests drive it directly, which is
// exactly the seam the reader subscribes to. Only the LLM work behind it is
// mocked away.
vi.mock('@/llm/moduleGen', async (importOriginal) => {
  const actual = await importOriginal<typeof moduleGenModule>();
  return {
    ...actual,
    runSpine: vi.fn(),
    runParts: vi.fn(),
    approveSpineAndRun: vi.fn(),
    retrySpine: vi.fn(),
    discardSpine: vi.fn(),
    cancelModuleGen: vi.fn(),
    generateMissingParts: vi.fn(),
    rewritePart: vi.fn(),
    createModuleAndRun: vi.fn(),
    classifyEntityName: vi.fn(),
  };
});

/** The real module, typed without an `import()` type annotation. */
const moduleGenModule = await import('@/llm/moduleGen');
const { moduleGenEvents } = moduleGenModule;

const PREMISE =
  'The party is hired to recover a drowned relic from the [[Old Tower]], where the [[Missing Person]] was last seen.';
const PART_COUNT = 4;

function partMarkdown(planIndex: number): string {
  return [
    `[PART-${String(planIndex)}]`,
    '',
    `The party reaches the [[Old Tower]] on leg ${String(planIndex)} and finds the keeper counting bells.`,
    '',
    '- The sluice is jammed with a broken rope.',
    '- The vault key is a bell clapper.',
  ].join('\n');
}

/** A ready module whose LAST part is mid-stream (`generating`, empty text). */
async function seedStreamingModule(): Promise<{
  campaign: Campaign;
  campaignId: Id;
  moduleId: Id;
  streamingIndex: number;
}> {
  await seedBuiltInPersonas();
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
    summary: 'A crumbling watchtower above the ford.',
  });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'A flooded vault beneath a watchtower.',
    levelMin: 1,
    levelMax: 4,
    tone: '',
    sizeDial: 'standard',
  });
  const streamingIndex = PART_COUNT - 1;
  const spine = moduleSpineSchema.parse({
    premise: PREMISE,
    themes: ['bargains'],
    partPlan: Array.from({ length: PART_COUNT }, (_, index) => ({
      title: `Part ${String(index + 1)}`,
      levelBand: String(index + 1),
      synopsis: `Chapter ${String(index + 1)} synopsis.`,
      levelUpTrigger: `Chapter ${String(index + 1)} closes.`,
    })),
  });
  const saved = await saveModule({
    ...draft,
    status: 'generating',
    errorMessage: '',
    spine,
    parts: Array.from({ length: PART_COUNT }, (_, planIndex) =>
      modulePartSchema.parse({
        planIndex,
        markdown: planIndex === streamingIndex ? '' : partMarkdown(planIndex),
        status: planIndex === streamingIndex ? 'generating' : 'ready',
        errorMessage: '',
        edited: false,
      }),
    ),
  });
  return { campaign, campaignId: campaign.id, moduleId: saved.id, streamingIndex };
}

function renderReaderAt(campaignId: Id, moduleId: Id): void {
  window.history.replaceState(null, '', modulePath(campaignId, moduleId));
  render(<RouterProvider router={createAppRouter()} />);
}

/** Mounts the reader and returns the streaming part's card. */
async function mountStreamingReader(): Promise<{
  campaignId: Id;
  moduleId: Id;
  streamingIndex: number;
  card: HTMLElement;
}> {
  const { campaignId, moduleId, streamingIndex } = await seedStreamingModule();
  renderReaderAt(campaignId, moduleId);
  const sections = await waitFor(
    () => {
      for (let index = 0; index < PART_COUNT; index += 1) {
        if (document.getElementById(`part-${String(index)}`) === null) {
          throw new Error(`part-${String(index)} not mounted yet`);
        }
      }
      return document.querySelectorAll('[data-testid="part-body"]');
    },
    { timeout: 10_000 },
  );
  expect(sections).toHaveLength(PART_COUNT - 1);
  const card = await screen.findByTestId('part-streaming', {}, { timeout: 10_000 });
  await flushAsyncUpdates();
  return { campaignId, moduleId, streamingIndex, card };
}

/**
 * Emits one token and waits for the store to RECORD at least part of it. The
 * emitter is fire-and-forget: a token emitted before the reader's bridge
 * effect has subscribed goes nowhere (nothing is buffered), and that
 * subscription is a passive effect — under parallel-worker load the first
 * emit can genuinely precede it, so the token is re-emitted until the store
 * shows text. That is the documented contract of an in-memory emitter, not a
 * workaround for a slow render.
 */
async function emitUntilStored(moduleId: Id, planIndex: number, delta: string): Promise<void> {
  await waitFor(() => {
    emitToken(moduleId, planIndex, delta);
    expect(streamTails.getSnapshot(moduleId, planIndex).tail).not.toBe('');
  });
}

/**
 * Streams `text` in three deltas and waits for the store to hold exactly it.
 * The last delta is the one re-emitted until it lands, so a retry can never
 * duplicate text that already arrived.
 */
async function streamTail(moduleId: Id, planIndex: number, text: string): Promise<void> {
  const first = text.slice(0, 4);
  const second = text.slice(4, 8);
  const rest = text.slice(8);
  await emitUntilStored(moduleId, planIndex, first);
  await emitUntilStored(moduleId, planIndex, second);
  emitToken(moduleId, planIndex, rest);
  await waitFor(() => {
    expect(streamTails.getSnapshot(moduleId, planIndex).tail).toContain(text);
  });
}

function emitToken(moduleId: Id, planIndex: number, delta: string): void {
  // `act` is SYNCHRONOUS here: the emitter is synchronous and its store
  // notification flushes inside this call (an async act would be a
  // non-Promise await).
  act(() => {
    moduleGenEvents.emit({ kind: 'part-token', moduleId, planIndex, delta });
  });
}

beforeEach(() => {
  parsesByPart.clear();
  return clearDatabase();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('reader stream churn', () => {
  it('re-parses no part when a streaming tick arrives in another part', async () => {
    const { moduleId, streamingIndex } = await mountStreamingReader();
    parsesByPart.clear();

    await streamTail(moduleId, streamingIndex, 'The gate holds. Nobody dives.');

    // THE PIN: a token tick rebuilds no markdown tree at all — not the six
    // ready parts, not the premise. Before the fix this was 5 parses per tick
    // (4 parts + premise), on every tick.
    expect([...parsesByPart.entries()]).toEqual([]);
  }, 20_000);

  it('shows the streaming tail, the thinking tail and their clearing, with the document intact', async () => {
    const { moduleId, streamingIndex, card } = await mountStreamingReader();

    // Thinking deltas stream dimmed; the first content delta clears them.
    act(() => {
      moduleGenEvents.emit({
        kind: 'part-thinking',
        moduleId,
        planIndex: streamingIndex,
        delta: 'Weighing ',
      });
      moduleGenEvents.emit({
        kind: 'part-thinking',
        moduleId,
        planIndex: streamingIndex,
        delta: 'the gate…',
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('thinking-tail')).toHaveTextContent('Weighing the gate…');
    });

    await streamTail(moduleId, streamingIndex, 'The gate holds.');
    expect(within(card).getByText(/The gate holds\./)).toBeInTheDocument();
    expect(within(card).queryByTestId('thinking-tail')).not.toBeInTheDocument();

    // The completed parts are still exactly what they were: the fix is
    // isolation, not a document that stops rendering.
    expect(document.querySelectorAll('[data-testid="part-body"]')).toHaveLength(PART_COUNT - 1);
    const part0 = document.getElementById('part-0');
    if (part0 === null) throw new Error('part-0 missing');
    expect(within(part0).getByTestId('part-body')).toHaveTextContent(
      'finds the keeper counting bells',
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('hands the streaming part over to its saved text', async () => {
    // The generator emits `done` in a `finally` AFTER the row write, so the
    // handover is the row's own status change: the streamed part becomes an
    // ordinary body with its saved markdown, and the tail card goes away.
    const { campaignId, moduleId, streamingIndex } = await seedStreamingModule();
    renderReaderAt(campaignId, moduleId);
    await screen.findByTestId('part-streaming', {}, { timeout: 10_000 });
    await streamTail(moduleId, streamingIndex, 'The gate holds.');
    expect(
      within(screen.getByTestId('part-streaming')).getByText(/The gate holds\./),
    ).toBeInTheDocument();

    await act(async () => {
      await patchModule(moduleId, {
        parts: Array.from({ length: PART_COUNT }, (_, planIndex) =>
          modulePartSchema.parse({
            planIndex,
            markdown: planIndex === streamingIndex ? 'The gate holds.' : partMarkdown(planIndex),
            status: 'ready',
            errorMessage: '',
            edited: false,
          }),
        ),
      });
      moduleGenEvents.emit({ kind: 'done', moduleId });
    });
    await flushAsyncUpdates();

    const section = document.getElementById(`part-${String(streamingIndex)}`);
    if (section === null) throw new Error('streamed part section missing');
    expect(within(section).getByTestId('part-body')).toHaveTextContent('The gate holds.');
    expect(screen.queryByTestId('part-streaming')).not.toBeInTheDocument();
  }, 20_000);

  it('drops the module’s tails when the reader unmounts', async () => {
    const { campaignId, moduleId, streamingIndex } = await seedStreamingModule();
    window.history.replaceState(null, '', modulePath(campaignId, moduleId));
    const view = render(<RouterProvider router={createAppRouter()} />);
    await screen.findByTestId('part-streaming', {}, { timeout: 10_000 });
    await streamTail(moduleId, streamingIndex, 'The gate holds.');
    expect(within(screen.getByTestId('part-streaming')).getByText(/The gate holds\./)).toBeInTheDocument();

    act(() => {
      view.unmount();
    });
    // Leaving the reader empties its tails: coming back must not show the
    // previous visit's stream.
    expect(streamTails.getSnapshot(moduleId, streamingIndex)).toEqual({
      tail: '',
      thinkingTail: '',
    });
  }, 20_000);

  it('re-parses no part when the page re-renders for an unrelated state change', async () => {
    // Hiding the contents sidebar is page-level state: it re-renders
    // `ModuleReaderPage` and every element it returns. jsdom has no layout, so
    // this is measured as markdown parses (the expensive half of a render),
    // not as paint cost. Before the fix, these parts' `memo` did not exist and
    // every one of them re-parsed.
    const { campaignId, moduleId } = await seedStreamingModule();
    renderReaderAt(campaignId, moduleId);
    await screen.findByTestId('module-title', {}, { timeout: 10_000 });
    await waitFor(
      () => {
        expect(document.querySelectorAll('[data-testid="part-body"]')).toHaveLength(PART_COUNT - 1);
      },
      { timeout: 10_000 },
    );
    await flushAsyncUpdates();

    const user = userEvent.setup();
    parsesByPart.clear();
    await user.click(screen.getByRole('button', { name: 'Hide table of contents' }));

    expect(screen.queryByTestId('module-toc')).not.toBeInTheDocument();
    expect([...parsesByPart.entries()]).toEqual([]);

    // The document itself is untouched — this pin is isolation, not a part
    // that stopped rendering.
    const part1 = document.getElementById('part-1');
    if (part1 === null) throw new Error('part-1 missing');
    expect(within(part1).getByTestId('part-body')).toHaveTextContent(
      'finds the keeper counting bells',
    );
    await flushAsyncUpdates();
  }, 20_000);
});
