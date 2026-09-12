import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type * as ModulePlanDialog from '@/features/modules/module-plan-dialog';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign, listGlobalArtifacts, publishToLibrary } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, patchModule } from '@/db/moduleRepo';
import {
  createModule as createModuleRow,
  moduleDocumentPlanSchema,
  type Artifact,
  type GlobalArtifact,
  type Module,
} from '@/domain';
import { CampaignTree } from '@/features/campaign/components/campaign-tree';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * THE DOCUMENT PLAN CONTROL IN THE CAMPAIGN TREE (docs/17 row 111).
 *
 * The owner was asked whether the plan surface should be reachable from the
 * campaign tree's module-group header as well as from the module canvas
 * header, and answered, verbatim: **"Yes, both places."**
 *
 * What this file pins, and why each half matters:
 *
 * 1. the module group header mounts the ONE SHARED component
 *    (`features/modules/module-plan-dialog.ModulePlanButton`, the same import
 *    the canvas header uses) with the module row and the SAME artifact pool the
 *    "Module PDF" control beside it gets — the assertion is on the component's
 *    own props, not on a button existing;
 * 2. clicking it opens the SAME dialog: the real component renders the real
 *    dialog and shows THIS module's stored plan;
 * 3. there is exactly ONE plan dialog in the app — a source scan, so a second
 *    surface can never be built by copying the file (no forked logic, no
 *    second way to regenerate a plan).
 */

const spies = vi.hoisted(() => ({ pdf: vi.fn(), plan: vi.fn() }));

// The PDF control is REPLACED by a spy that records its props: the point here
// is the pool both controls receive, not the PDF menu.
vi.mock('@/features/modules/module-pdf-button', () => ({
  ModulePdfButton: (props: { module: { id: string }; artifacts: readonly unknown[] }) => {
    spies.pdf(props);
    return <span data-testid="module-pdf-control" />;
  },
}));

// The plan control is WRAPPED, not replaced: the real component renders (so
// clicking opens the real dialog) and its props are recorded.
vi.mock('@/features/modules/module-plan-dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof ModulePlanDialog>();
  const Actual = actual.ModulePlanButton;
  return {
    ...actual,
    ModulePlanButton: (props: Parameters<typeof Actual>[0]) => {
      spies.plan(props);
      return <Actual {...props} />;
    },
  };
});

let module: Module;
let campaignArtifacts: Artifact[];
let globals: GlobalArtifact[];

function source(relativePath: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', '..', relativePath), 'utf8');
}

/** Every `.ts`/`.tsx` file under `src/`, for the "only one dialog" scan. */
function sourceFiles(dir = resolve(import.meta.dirname, '..', '..', 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(path);
  }
  return out;
}

const PLAN = moduleDocumentPlanSchema.parse({
  sections: [
    {
      title: 'Before the Gate',
      role: 'explanation',
      audience: 'all',
      source: { type: 'part', planIndex: -1 },
      images: [],
    },
    {
      title: 'The Tide Gate',
      role: 'read-aloud',
      audience: 'all',
      source: { type: 'part', planIndex: 0 },
      images: [],
    },
  ],
  plannedByModel: 'vendor/planner-1',
  plannedAt: 1_700_000_000_000,
});

beforeEach(async () => {
  await clearDatabase();
  spies.pdf.mockClear();
  spies.plan.mockClear();
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  module = await createModule(
    createModuleRow({
      campaignId: campaign.id,
      title: 'Ember Crypt',
      concept: 'A drowned crypt.',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'sketch',
    }),
  );
  // The module row carries a plan, so the dialog's own content is the proof
  // that this module's data reached it.
  await patchModule(module.id, { documentPlan: PLAN });
  // One module-owned row gives the tree its module GROUP; one published row
  // gives the library half of the pool.
  await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: 'Kael',
    summary: '',
    body: '',
  });
  const published = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
    summary: '',
    body: '',
  });
  await publishToLibrary(published.id);
  campaignArtifacts = await listArtifactsByCampaign(campaign.id);
  globals = await listGlobalArtifacts();
});

function renderTree(): void {
  render(
    <MemoryRouter>
      <CampaignTree
        campaignId={module.campaignId}
        artifacts={campaignArtifacts}
        globals={globals}
        selectedArtifactId={undefined}
        onSelectArtifact={() => undefined}
      />
    </MemoryRouter>,
  );
}

describe('the plan control in the module group header', () => {
  it('mounts the SHARED component, with the module and the export control’s pool', async () => {
    renderTree();
    await screen.findByTestId('module-plan-button');
    await flushAsyncUpdates();

    // The shared component is genuinely mounted (its real button is rendered)…
    expect(screen.getByTestId('module-plan-button')).toHaveTextContent('Document plan');
    expect(screen.getByTestId('module-pdf-control')).toBeInTheDocument();

    // …and it was handed THIS module's row, not an id or a copy of the data.
    const planCalls = spies.plan.mock.calls;
    expect(planCalls.length).toBeGreaterThan(0);
    const planProps = planCalls[planCalls.length - 1]?.[0] as { module: Module; artifacts: readonly Artifact[] };
    expect(planProps.module.title).toBe('Ember Crypt');
    expect(planProps.module.documentPlan).toEqual(PLAN);
    expect(new Set(planCalls.map((call) => (call[0] as { module: Module }).module.id))).toEqual(
      new Set([module.id]),
    );

    // The SAME reach as the export control the owner already has in both
    // places: the campaign's rows plus the shared library, in that order.
    const pdfProps = spies.pdf.mock.calls[0]?.[0] as { artifacts: readonly Artifact[] };
    expect(planProps.artifacts.map((row) => row.name)).toEqual(['Kael', 'Old Tower']);
    expect(planProps.artifacts).toEqual(pdfProps.artifacts);
  });

  it('opens the SAME dialog, showing this module’s stored plan', async () => {
    renderTree();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('module-plan-button'));

    // The dialog the canvas header opens, with the module's own plan in it.
    expect(await screen.findByTestId('module-plan-dialog')).toBeInTheDocument();
    expect(screen.getAllByTestId('module-plan-section')).toHaveLength(2);
    expect(screen.getByTestId('module-plan-count')).toHaveTextContent('2 sections');
    expect(screen.getByTestId('module-plan-model')).toHaveAttribute('data-model', 'vendor/planner-1');
    expect(screen.getByTestId('module-plan-regenerate')).toHaveTextContent('Regenerate');
  });

  it('the tree carries no second plan surface: one import, one dialog, one regeneration path', () => {
    const root = resolve(import.meta.dirname, '..', '..');
    const read = (file: string): string => source(relative(root, file));
    const named = (predicate: (text: string) => boolean): string[] =>
      sourceFiles().filter((file) => predicate(read(file))).map((file) => relative(root, file)).sort();

    const tree = source('src/features/campaign/components/campaign-tree.tsx');

    // The tree reaches the surface through the SHARED module's import…
    expect(tree).toContain("from '@/features/modules/module-plan-dialog'");
    expect(tree).toContain('<ModulePlanButton');
    // …and carries none of the dialog's own machinery: no dialog markup, no
    // plan read, no second regeneration call, no forked write of `documentPlan`.
    expect(tree).not.toContain('data-testid="module-plan-dialog"');
    expect(tree).not.toContain('planModuleDocument');
    expect(tree).not.toContain('readStoredDocumentPlan');
    expect(tree).not.toContain('documentPlan');

    // Across the whole app each load-bearing piece lives in ONE file: a copy
    // of the dialog to a second surface fails every one of these scans.
    expect(named((text) => text.includes('data-testid="module-plan-dialog"'))).toEqual([
      'src/features/modules/module-plan-dialog.tsx',
    ]);
    expect(named((text) => text.includes('await planModuleDocument({'))).toEqual([
      'src/features/modules/module-plan-dialog.tsx',
    ]);
    expect(
      named((text) => text.includes('patchModule(module.id, { documentPlan')),
    ).toEqual(['src/features/modules/module-plan-dialog.tsx']);
  });
});
