import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { canvasPath } from '@/app/routes';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  moduleDocumentPlanSchema,
  modulePartSchema,
  moduleSpineSchema,
  readStoredDocumentPlan,
  type Id,
  type Module,
  type ModuleDocumentPlan,
} from '@/domain';
import type * as FilePickerModule from '@/lib/filePicker';
import type * as OpenRouterModule from '@/llm/openrouter';
import type * as PdfExportModule from '@/lib/pdfExport';
import { clearDatabase } from '../db/helpers';
import { useProgressStore } from '@/lib/progress';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';

/**
 * EXPORT PLANS FOR ITSELF (docs/17 row 139, docs/07 §M3-D). The owner's
 * report, verbatim: *"i just noticed this document plan button. Bad design to
 * put one functionality behind 2 buttons that need to be pressed sequentially.
 * And i do want to have that automatic."*
 *
 * What this file pins, through the REAL export entry point (`ModulePdfButton`
 * on the canvas, the ONE component the campaign tree mounts too), with only the
 * protocol boundary faked (`llm/openrouter.chat`) — the real planner, the real
 * `patchModule` write and the real renderer all run:
 *
 * 1. **ONE press produces the planned document.** No plan press, no dialog:
 *    the export plans (exactly ONE model call), stores the plan with its
 *    provenance, and the written file is the PLANNED book — the procedural
 *    outline does not print. This is the failing pin that reproduces the
 *    owner's complaint at the base commit (where no plan was produced at all).
 * 2. **Every export plans, always — the stored plan is NOT a cache** (owner
 *    decision in row 139): an export on a module that already holds a valid
 *    plan still calls the planner exactly once, and the stored plan is
 *    REPLACED by the new one, provenance included.
 * 3. **A planning failure is loud and the outcome is never mistakable for
 *    success**: a `toastError` naming the reason, NO success toast, the file
 *    still written, and a statement IN the document saying which book it
 *    printed instead (the procedural outline, or the module's LAST stored plan
 *    when it has one — the escape hatch that costs no call), plus no fabricated
 *    plan on the row.
 * 4. **The planning call shows the app's progress surface** while it runs, and
 *    the job is gone when the export ends.
 */
const openSaveTargetMock = vi.fn();
const writeMock = vi.fn();
const generatePdfBlobMock = vi.fn();

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof OpenRouterModule>()),
  chat: vi.fn(),
}));

vi.mock('@/lib/filePicker', async (importOriginal) => ({
  ...(await importOriginal<typeof FilePickerModule>()),
  openSaveTarget: (...args: unknown[]) => openSaveTargetMock(...args) as unknown,
}));

vi.mock('@/lib/pdfExport', async (importOriginal) => ({
  ...(await importOriginal<typeof PdfExportModule>()),
  generatePdfBlob: (...args: unknown[]) => generatePdfBlobMock(...args) as unknown,
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastInfo, toastSuccess } = await import('@/lib/toast');

let world: { campaignId: Id; moduleId: Id } = { campaignId: '', moduleId: '' };

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

/** The plan the faked planner returns: one section per shape it may name. */
function replySections(...titles: [string, string]): unknown[] {
  return [
    {
      title: titles[0],
      role: 'read-aloud',
      audience: 'all',
      source: { type: 'part', planIndex: -1 },
      images: [],
    },
    {
      title: titles[1],
      role: 'explanation',
      audience: 'all',
      source: { type: 'part', planIndex: 0 },
      images: [],
    },
  ];
}

function plannerReplies(sections: unknown[], modelUsed = 'vendor/planner-auto'): void {
  chatMock.mockResolvedValue({
    text: JSON.stringify({ sections }),
    modelUsed,
    fallback: null,
  });
}

/** A plan ALREADY on the row — the state the cache reading would have skipped. */
function storedPlan(title: string, model: string): ModuleDocumentPlan {
  return moduleDocumentPlanSchema.parse({
    sections: [
      {
        title,
        role: 'explanation',
        audience: 'all',
        source: { type: 'part', planIndex: 0 },
        images: [],
      },
    ],
    plannedByModel: model,
    plannedAt: 1_700_000_000_000,
  });
}

/** The module row as it stands: a missing row fails the pin by name. */
async function requiredModule(): Promise<Module> {
  const row = await actDrained(() => getModule(world.moduleId));
  if (row === undefined) throw new Error('the module row is gone');
  return row;
}

/** The definition the export handed the PDF generator (the book it wrote). */
function generatedDefinitionText(): string {
  const call = generatePdfBlobMock.mock.calls[0] as unknown[] | undefined;
  expect(call, 'the export never reached the PDF generator').toBeDefined();
  return JSON.stringify(call?.[0]);
}

async function exportOnce(): Promise<void> {
  const user = userEvent.setup();
  renderAppAt(canvasPath(world.campaignId, world.moduleId));
  await screen.findByTestId('module-canvas', {}, { timeout: 10_000 });
  await flushAsyncUpdates();
  await user.click(screen.getByTestId('module-pdf-menu'));
  await user.click(await screen.findByTestId('module-pdf-gm'));
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  openSaveTargetMock.mockResolvedValue({ cancelled: false, write: writeMock });
  writeMock.mockResolvedValue(undefined);
  generatePdfBlobMock.mockResolvedValue(
    new Blob(['%PDF-fake'], { type: 'application/pdf' }),
  );

  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Vault',
    concept: 'concept',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
    includePriorModules: false,
  });
  await saveModule({
    ...draft,
    spine: moduleSpineSchema.parse({
      premise: 'A drowned vault.',
      themes: [],
      partPlan: [{ title: 'The Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party rows out.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  world = { campaignId: campaign.id, moduleId: draft.id };
});

describe('one press exports the planned document — the plan is not a step', () => {
  it('plans, stores the plan with its provenance, and writes the PLANNED book on a single press', async () => {
    plannerReplies(replySections('The Drowned Gate', 'Into the Vault'));
    await exportOnce();
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });

    // 1. The planner RAN — exactly once — through the ordinary transport seam.
    expect(chatMock).toHaveBeenCalledTimes(1);
    const system = chatMock.mock.calls[0]?.[0][0]?.content;
    expect(typeof system === 'string' ? system : '').toContain('layout planner for a tabletop RPG module PDF');

    await flushAsyncUpdates();
    // 2. The plan is on the ROW, with provenance written by the app.
    const row = await actDrained(() => getModule(world.moduleId));
    const stored = readStoredDocumentPlan(row?.documentPlan);
    expect(stored.status).toBe('valid');
    if (stored.status !== 'valid') throw new Error('unreachable');
    expect(stored.plan.plannedByModel).toBe('vendor/planner-auto');
    expect(stored.plan.plannedAt).toBeGreaterThan(0);
    expect(stored.plan.sections.map((section) => section.title)).toEqual([
      'The Drowned Gate',
      'Into the Vault',
    ]);

    // 3. The document that was WRITTEN is the planned one: the plan's titles
    //    are the book's chapters and the procedural outline did not print —
    //    one press, and nobody opened the plan dialog.
    const text = generatedDefinitionText();
    expect(text).toContain('The Drowned Gate');
    expect(text).toContain('Into the Vault');
    expect(text).not.toContain('"text":"Premise"');
    expect(text).not.toContain('"text":"Part plan"');
    expect(text).not.toContain('procedural outline');
    // Reported as a clean export, not as a fallback.
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('plans on EVERY export — a valid stored plan is replaced, not reused (the plan is not a cache)', async () => {
    await saveModule({
      ...(await requiredModule()),
      documentPlan: storedPlan('The Old Decision', 'vendor/previous'),
    });
    plannerReplies(replySections('The New Decision', 'The Vault Below'), 'vendor/planner-2');
    await exportOnce();
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });

    // Exactly ONE call even though a perfectly valid plan was already stored.
    expect(chatMock).toHaveBeenCalledTimes(1);
    const row = await actDrained(() => getModule(world.moduleId));
    const stored = readStoredDocumentPlan(row?.documentPlan);
    expect(stored.status).toBe('valid');
    if (stored.status !== 'valid') throw new Error('unreachable');
    // REPLACED (one section, the new title) and re-stamped.
    expect(stored.plan.sections.map((section) => section.title)).toEqual([
      'The New Decision',
      'The Vault Below',
    ]);
    expect(stored.plan.plannedByModel).toBe('vendor/planner-2');
    expect(stored.plan.plannedAt).toBeGreaterThan(1_700_000_000_000);

    const text = generatedDefinitionText();
    expect(text).toContain('The New Decision');
    expect(text).not.toContain('The Old Decision');
  });

  it('shows the shared progress surface while the planning call runs, and clears it after', async () => {
    // Observed from INSIDE the planning call: whatever the progress seam holds
    // at that instant is what the dock (AppShell) is rendering — a bare
    // disabled button is not a progress experience, and this is the moment the
    // owner would otherwise be staring at one.
    const job = `module-pdf:${world.moduleId}`;
    let duringPlanning: { label: string; detail: string } | null = null;
    chatMock.mockImplementation(() => {
      // We are INSIDE the planning call right now.
      const live = useProgressStore.getState().jobs.find((entry) => entry.id === job);
      duringPlanning = live === undefined ? null : { label: live.label, detail: live.detail };
      return Promise.resolve({
        text: JSON.stringify({ sections: replySections('The Drowned Gate', 'Into the Vault') }),
        modelUsed: 'vendor/planner-auto',
        fallback: null,
      });
    });

    await exportOnce();
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });
    await flushAsyncUpdates();

    expect(duringPlanning).toEqual({
      label: 'Exporting The Drowned Vault',
      detail: 'Planning the document…',
    });
    // …and nothing is left running when the export ends.
    expect(useProgressStore.getState().jobs).toEqual([]);
  });
});

describe('a planning failure is loud, and the outcome is never mistakable for success', () => {
  it('reports the planner’s reason, still exports, and says IN the document that planning failed', async () => {
    chatMock.mockRejectedValue(new Error('vendor/planner-1 returned no content'));
    await exportOnce();
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });

    // 1. LOUD, named, and never a success report.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toastError).mock.calls[0]?.[0]).toBe(
      'Could not plan the document — exporting without a fresh plan',
    );
    expect(vi.mocked(toastError).mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(toastSuccess).not.toHaveBeenCalled();
    // 2. …and the problems list of the export names the plan too.
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toastInfo).mock.calls[0]?.[0]).toContain('the automatic planning step failed');

    // 3. The document states it on its own page: no plan was stored, so the
    //    procedural outline printed — said out loud, not silently.
    const text = generatedDefinitionText();
    expect(text).toContain('procedural outline');
    expect(text).toContain('the automatic planning step for this export failed');
    expect(text).toContain('vendor/planner-1 returned no content');

    // 4. NOTHING was fabricated on the row (AGENTS rule 1).
    const row = await actDrained(() => getModule(world.moduleId));
    expect(readStoredDocumentPlan(row?.documentPlan).status).toBe('absent');
  });

  it('falls back to the module’s LAST stored plan when the call fails — one book, no call, still stated', async () => {
    await saveModule({
      ...(await requiredModule()),
      documentPlan: storedPlan('The Last Book', 'vendor/previous'),
    });
    chatMock.mockRejectedValue(new Error('network down'));
    await exportOnce();
    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledTimes(1);
    });

    expect(toastError).toHaveBeenCalledTimes(1);
    const text = generatedDefinitionText();
    // The LAST planned book printed (the escape hatch), and the document says
    // which book this is rather than pretending it is a fresh plan.
    expect(text).toContain('The Last Book');
    expect(text).toContain('LAST STORED document plan');
    expect(text).toContain('network down');
    expect(text).not.toContain('procedural outline');

    // The stored plan is untouched: a failed call writes nothing.
    const row = await actDrained(() => getModule(world.moduleId));
    const stored = readStoredDocumentPlan(row?.documentPlan);
    expect(stored.status).toBe('valid');
    if (stored.status !== 'valid') throw new Error('unreachable');
    expect(stored.plan.plannedByModel).toBe('vendor/previous');
    expect(stored.plan.plannedAt).toBe(1_700_000_000_000);
  });
});

/** Non-vacuity for the fixtures: the module really does have something to plan. */
describe('the fixture is plannable', () => {
  it('the seeded module has a spine and a part', async () => {
    const row: Module | undefined = await getModule(world.moduleId);
    expect(row?.spine?.partPlan).toHaveLength(1);
    expect(row?.parts).toHaveLength(1);
  });
});
