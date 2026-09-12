import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  moduleDocumentPlanSchema,
  moduleSpineSchema,
  newId,
  readStoredDocumentPlan,
  type AnyArtifact,
  type Module,
} from '@/domain';
import { ModulePlanButton } from '@/features/modules/module-plan-dialog';
import { buildCampaignExport, importExport } from '@/lib/exportImport';
import { toastError } from '@/lib/toast';
import { clearDatabase } from '../db/helpers';

/**
 * THE DOCUMENT PLAN SURFACE (docs/17 row 109, docs/05 §Module PDF). What the
 * owner does with the plan, and what he must never have to guess:
 *
 * - he can SEE the model's decision — every section, in order, with its title,
 *   role, audience and image anchors, and the model that made it;
 * - he can ask for another one (ONE action; no builder, no tree, no add /
 *   remove / reorder) and correct the one decision that changes what a player
 *   may read;
 * - a FAILED regeneration is loud and leaves the previous plan untouched —
 *   never a cleared field, never a half-written plan;
 * - the plan is a MODULE ROW field, so it rides campaign export/import whole.
 */

vi.mock('@/llm/modulePlan', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  planModuleDocument: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { planModuleDocument } = await import('@/llm/modulePlan');
const planMock = vi.mocked(planModuleDocument);
const toastErrorMock = vi.mocked(toastError);

const LOCATION_ID = newId();
const ENCOUNTER_ID = newId();
const IMAGE_ID = newId();

const ARTIFACTS: AnyArtifact[] = [
  { id: LOCATION_ID, kind: 'location', name: 'Old Tower' } as AnyArtifact,
  { id: ENCOUNTER_ID, kind: 'encounter', name: 'Pier Ambush' } as AnyArtifact,
];

let module: Module;

function plan(overrides: Record<string, unknown> = {}) {
  return moduleDocumentPlanSchema.parse({
    sections: [
      {
        title: 'Before the Gate',
        role: 'explanation',
        audience: 'all',
        source: { type: 'part', planIndex: -1 },
        images: [],
      },
      {
        title: 'The Old Tower',
        role: 'read-aloud',
        audience: 'all',
        source: { type: 'artifact', artifactId: LOCATION_ID },
        images: [IMAGE_ID],
      },
      {
        title: 'Ambush on the Pier',
        role: 'gm-note',
        audience: 'gm',
        source: { type: 'encounter', artifactId: ENCOUNTER_ID },
        images: [],
      },
    ],
    plannedByModel: 'vendor/planner-1',
    plannedAt: 1_700_000_000_000,
    ...overrides,
  });
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  const campaign = await createCampaign({ name: 'Surface Campaign', system: 'dnd5e' });
  module = await saveModule({
    ...createModule({
      campaignId: campaign.id,
      title: 'Beneath the Docks',
      concept: 'A drowned vault.',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
    }),
    spine: moduleSpineSchema.parse({
      premise: 'A drowned vault.',
      themes: [],
      partPlan: [
        { title: 'The Dockyards', levelBand: '1-2', synopsis: '', levelUpTrigger: '' },
        { title: 'The Vault', levelBand: '3', synopsis: '', levelUpTrigger: '' },
      ],
    }),
  });
});

async function open(): Promise<void> {
  const user = userEvent.setup();
  render(<ModulePlanButton module={module} artifacts={ARTIFACTS} />);
  await user.click(screen.getByTestId('module-plan-button'));
  expect(await screen.findByTestId('module-plan-dialog')).toBeInTheDocument();
}

describe('inspecting what the AI decided', () => {
  it('says there is no plan yet, and offers to plan one', async () => {
    await open();
    expect(screen.getByTestId('module-plan-absent')).toHaveTextContent('No plan yet');
    expect(screen.getByTestId('module-plan-generate')).toHaveTextContent('Generate plan');
    // No plan means no section list and no model claim.
    expect(screen.queryByTestId('module-plan-sections')).toBeNull();
    expect(screen.queryByTestId('module-plan-model')).toBeNull();
  });

  it('lists every section in order, with its role, audience, source and anchors', async () => {
    module = { ...module, documentPlan: plan() };
    await open();

    const rows = screen.getAllByTestId('module-plan-section');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector('.font-medium')?.textContent)).toEqual([
      'Before the Gate',
      'The Old Tower',
      'Ambush on the Pier',
    ]);
    // The ROLE and the AUDIENCE are data attributes (the owner's inspection
    // surface), and the audience default shows up where it belongs: the
    // encounter's GM note is GM-only.
    expect(rows[0]?.dataset.role).toBe('explanation');
    expect(rows[0]?.dataset.audience).toBe('all');
    expect(rows[1]?.dataset.role).toBe('read-aloud');
    expect(rows[2]?.dataset.role).toBe('gm-note');
    expect(rows[2]?.dataset.audience).toBe('gm');
    // The role MEANING is spelled out, so the vocabulary is not a secret code.
    expect(rows[1]?.textContent).toContain('printed in the read-aloud box');
    // The SOURCE is named in the owner's terms: the premise, a real artifact
    // with its kind, and an encounter.
    expect(rows[0]?.textContent).toContain('The premise');
    expect(rows[1]?.textContent).toContain('Old Tower · location');
    expect(rows[2]?.textContent).toContain('Pier Ambush · encounter');
    // Anchored images are visible as a count, and only where they exist.
    expect(screen.getAllByTestId('module-plan-anchors')).toHaveLength(1);
    expect(rows[1]?.textContent).toContain('1 image');
    // Provenance: the model that made this decision, and the count.
    expect(screen.getByTestId('module-plan-model')).toHaveAttribute('data-model', 'vendor/planner-1');
    expect(screen.getByTestId('module-plan-count')).toHaveTextContent('3 sections');
  });

  it('names a STORED plan that is not valid, and offers to replace it', async () => {
    module = { ...module, documentPlan: { sections: [{ title: 'nope' }] } };
    await open();

    expect(screen.getByTestId('module-plan-invalid')).toHaveTextContent('sections.0.role');
    expect(screen.getByTestId('module-plan-invalid')).toHaveTextContent('procedural outline');
    expect(screen.getByTestId('module-plan-generate')).toHaveTextContent('Replace it');
    expect(screen.queryByTestId('module-plan-sections')).toBeNull();
  });

  it('offers NO structural editing: one action, plus the audience', async () => {
    module = { ...module, documentPlan: plan() };
    await open();

    // The only actions in the dialog are the ONE planning action and a way
    // out (ours, plus the dialog's own X, which is also named "Close").
    const named = screen
      .getAllByRole('button')
      .map((button) => button.textContent.trim());
    expect(named.filter((label) => label === 'Regenerate')).toHaveLength(1);
    expect(named.filter((label) => label === 'Close')).toHaveLength(2);
    // And the only per-section control is the audience select — no add, no
    // remove, no reorder, no styling.
    const menus = screen.getAllByRole('combobox');
    expect(menus).toHaveLength(3);
    for (const menu of menus) expect(menu).toHaveAttribute('aria-label', expect.stringContaining('Audience of'));
    expect(screen.queryByRole('button', { name: /add section/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /move|up|down/i })).toBeNull();
  });
});

describe('planning and regenerating', () => {
  it('writes the planned plan to the MODULE ROW (the only write site)', async () => {
    planMock.mockResolvedValue({ plan: plan(), modelUsed: 'vendor/planner-1' });
    await open();
    const user = userEvent.setup();

    // The seam is handed the module id and the artifact pool; it is never
    // handed a callback or a place to write.
    await user.click(screen.getByTestId('module-plan-generate'));
    await waitFor(async () => {
      const row = await getModule(module.id);
      expect(readStoredDocumentPlan(row?.documentPlan).status).toBe('valid');
    });

    expect(planMock).toHaveBeenCalledTimes(1);
    const call = planMock.mock.calls[0]?.[0];
    expect(call?.moduleId).toBe(module.id);
    expect(call?.artifacts).toEqual(ARTIFACTS);
    expect(call?.turn).toBeInstanceOf(AbortController);
    const row = await getModule(module.id);
    const stored = readStoredDocumentPlan(row?.documentPlan);
    expect(stored.status === 'valid' ? stored.plan.sections.length : 0).toBe(3);
  });

  it('leaves the PREVIOUS plan exactly as it was when planning fails', async () => {
    const previous = plan();
    const { patchModule } = await import('@/db/moduleRepo');
    await patchModule(module.id, { documentPlan: previous });
    module = { ...module, documentPlan: previous };
    planMock.mockRejectedValue(new Error('vendor/planner-1 returned no content'));
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('module-plan-regenerate'));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        'Could not plan the document',
        expect.any(Error),
      );
    });
    const row = await getModule(module.id);
    expect(row?.documentPlan).toEqual(previous);
    // The dialog is still usable: the failure did not close it or clear it.
    expect(screen.getByTestId('module-plan-sections')).toBeInTheDocument();
  });

  it('writes nothing at all when the reply names something that does not exist', async () => {
    planMock.mockRejectedValue(
      new Error('The document plan names something that does not exist: section “X”'),
    );
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('module-plan-generate'));
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
    const row = await getModule(module.id);
    // NOT a partial plan, NOT an empty object: the field stays absent.
    expect(row?.documentPlan ?? null).toBeNull();
  });

  it('corrects ONE section’s audience on the stored plan (the one available fix)', async () => {
    module = { ...module, documentPlan: plan() };
    await open();
    const user = userEvent.setup();

    await user.click(screen.getByTestId('module-plan-audience-0'));
    await user.click(await screen.findByRole('option', { name: 'GM only' }));

    await waitFor(async () => {
      const row = await getModule(module.id);
      const stored = readStoredDocumentPlan(row?.documentPlan);
      expect(stored.status === 'valid' ? stored.plan.sections[0]?.audience : null).toBe('gm');
    });
    const row = await getModule(module.id);
    const stored = readStoredDocumentPlan(row?.documentPlan);
    // Only the audience moved: order, titles, roles and anchors are untouched.
    expect(stored.status === 'valid' ? stored.plan.sections.map((s) => s.title) : []).toEqual([
      'Before the Gate',
      'The Old Tower',
      'Ambush on the Pier',
    ]);
    expect(stored.status === 'valid' ? stored.plan.sections[1]?.images : []).toEqual([IMAGE_ID]);
    expect(stored.status === 'valid' ? stored.plan.plannedByModel : '').toBe('vendor/planner-1');
  });
});

describe('the plan is a module row field (persistence and export)', () => {
  it('round-trips through patch/read, and rides campaign export/import whole', async () => {
    const stored = plan();
    const { patchModule } = await import('@/db/moduleRepo');
    await patchModule(module.id, { documentPlan: stored });

    const reread = await getModule(module.id);
    expect(readStoredDocumentPlan(reread?.documentPlan).status).toBe('valid');
    expect(reread?.documentPlan).toEqual(stored);

    // A campaign export carries the module WHOLE, so the plan is in the file…
    const exported = await buildCampaignExport(module.campaignId);
    const serialized = JSON.parse(JSON.stringify(exported)) as {
      modules?: { title: string; documentPlan?: unknown }[];
    };
    const exportedModule = serialized.modules?.find((row) => row.title === 'Beneath the Docks');
    expect(exportedModule).toBeDefined();
    expect(exportedModule?.documentPlan).toEqual(stored);

    // …and importing it into a cleared database restores it (a new id, the
    // same decision — the plan is data, not a pointer into this database).
    await clearDatabase();
    await importExport(serialized);
    const { listModulesByCampaign } = await import('@/db/moduleRepo');
    const { listCampaigns } = await import('@/db/campaignRepo');
    const importedCampaign = (await listCampaigns()).find((row) => row.name === 'Surface Campaign');
    const imported = (
      await listModulesByCampaign(importedCampaign?.id ?? '')
    ).find((row) => row.title === 'Beneath the Docks');
    const readBack = readStoredDocumentPlan(imported?.documentPlan);
    expect(readBack.status).toBe('valid');
    expect(readBack.status === 'valid' ? readBack.plan.sections : []).toEqual(stored.sections);
    expect(readBack.status === 'valid' ? readBack.plan.plannedAt : 0).toBe(stored.plannedAt);
  });

  it('reads absence as absent through the row, never as an error', async () => {
    const row = await getModule(module.id);
    expect(row?.documentPlan ?? null).toBeNull();
    expect(readStoredDocumentPlan(row?.documentPlan).status).toBe('absent');
  });
});
