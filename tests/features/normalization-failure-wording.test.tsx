import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { cleanup, render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { createModule, modulePartSchema, moduleSpineSchema, type Id, type Module } from '@/domain';
import { EntityPanel } from '@/features/modules/entity-panel';
import { useProgressStore } from '@/lib/progress';
import { NORMALIZATION_FAILURE_MESSAGE } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

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

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

/**
 * The panel's BELT is the subject here — the catch for a throw the pass did not
 * record itself — so the pass is a mock. Everything else from the module stays
 * real (the same partial mock `stop-canvas-normalization.test.ts` uses).
 */
vi.mock('@/llm/moduleGen', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  normalizeModuleEntityNames: vi.fn(),
}));

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const { normalizeModuleEntityNames } = await import('@/llm/moduleGen');
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
      partPlan: [
        { title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' },
      ],
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
      expect(toastErrorMock).toHaveBeenCalledWith(NORMALIZATION_FAILURE_MESSAGE, expect.any(Error));
    });
    // The panel imports the seam's sentence — it is not a second wording that
    // happens to match today (the source scan below is what enforces it).
    expect(NORMALIZATION_FAILURE_MESSAGE).toBe(SENTENCE);
  }, 20000);
});

describe('the failure sentence is ONE wording', () => {
  it('is stated in exactly one source file, and the panel reads it from there', () => {
    const root = resolve(import.meta.dirname, '..', '..');
    const files = sourceFiles(resolve(root, 'src'));
    // Non-vacuity: this really walked the source tree, so the scan below can
    // only pass because it read files at all.
    expect(files.length).toBeGreaterThan(50);

    const stated = files
      .filter((file) => readFileSync(file, 'utf8').includes(SENTENCE))
      .map((file) => relative(root, file));
    // A fourth copy of the wording anywhere in the app fails this — the shape
    // that drifted into a missing cancel guard once already.
    expect(stated).toEqual(['src/llm/moduleGen.ts']);

    // The two surfaces that must keep saying it reach it through the export:
    // the panel's belt, and the pass's own recording seam.
    const panel = readFileSync(resolve(root, 'src', 'features', 'modules', 'entity-panel.tsx'), 'utf8');
    expect(panel).toContain('NORMALIZATION_FAILURE_MESSAGE');
    expect(panel).not.toContain(SENTENCE);
    const gen = readFileSync(resolve(root, 'src', 'llm', 'moduleGen.ts'), 'utf8');
    // Exactly one statement of the sentence inside the seam…
    expect(gen.split(SENTENCE)).toHaveLength(2);
    // …and FIVE catches that go through the seam instead of restating it: the
    // post-parts pass, the re-normalization after a floor repair, the repair
    // pass, the full pass's own catch and the incremental classification's.
    expect(gen.match(/recordNormalizationFailure\(error\)/g)).toHaveLength(5);
  }, 20000);
});

/** Every `.ts`/`.tsx` file under `dir` (a small explicit walk — no glob dep). */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}
