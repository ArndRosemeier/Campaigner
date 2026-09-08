import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAppRouter } from '@/app/router';
import {
  ROUTES,
  boardPath,
  canvasPath,
  deliverablesPath,
  graphPath,
  workspacePath,
} from '@/app/routes';
import {
  DEFAULT_UI_SCALE,
  useUiScaleStore,
} from '@/app/theme/uiScale';
import { ARTIFACT_KINDS, type ArtifactKind, ruleChunkSchema, stampNewEntity } from '@/domain';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
} from '@/domain';
import { artifactRepo } from '@/db';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { createRulebook, updateRulebook } from '@/db/rulebookRepo';
import { createRun, updateRun } from '@/db/runRepo';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { listPersonas } from '@/db/personaRepo';
import { clearDatabase } from '../db/helpers';

/**
 * Route smoke sweep (docs/08-TESTING.md §Route sweep).
 *
 * Mounts every route of the real app shell against one seeded campaign that
 * contains an artifact of EVERY kind, a built-in persona set with a completed
 * run, and a ready rulebook with one chunk. Each test asserts a landmark and
 * — where nothing else covers a surface — opens the interactions that no
 * dedicated test exercises (tree tooltip, context menu + rename dialog,
 * quick-find on the workspace, editor per kind, collapse/filter). The
 * console-hygiene guard (tests/setup.ts) fails the whole file on any
 * console.error/warn, so render-time breakage that only shows up as browser
 * warnings cannot hide here.
 */

const KIND_NAMES: Record<ArtifactKind, string> = {
  pc: 'Serren',
  npc: 'Gorim',
  location: 'Old Docks',
  event: 'Harvest Feast',
  faction: 'Harbor Guild',
  note: 'Rumors',
  encounter: 'Dock Ambush',
  plotarc: 'The Sunken Crown',
};

let world: { campaignId: string; moduleId: string } = { campaignId: '', moduleId: '' };

async function seedSmokeWorld(): Promise<{ campaignId: string; moduleId: string }> {
  const campaign = await createCampaign({ name: 'Smoke', system: 'dnd5e' });
  for (const kind of ARTIFACT_KINDS) {
    await artifactRepo.createArtifact({
      campaignId: campaign.id,
      kind,
      name: KIND_NAMES[kind],
      summary: `Summary of ${KIND_NAMES[kind]}`,
      body: `# ${KIND_NAMES[kind]}\n\nSmoke body.`,
    });
  }

  await seedBuiltInPersonas();
  const personas = await listPersonas();
  const persona = personas[0];
  if (persona === undefined) throw new Error('seedBuiltInPersonas produced no personas');
  const run = await createRun({
    campaignId: campaign.id,
    personaId: persona.id,
    autonomy: 'manual',
    userBrief: 'a smoke-test run',
  });
  await updateRun(run.id, { status: 'completed' });

  const book = await createRulebook({
    title: 'Smoke Book',
    system: 'dnd5e',
    filename: 'smoke.pdf',
  });
  await updateRulebook(book.id, { status: 'ready', pageCount: 12 });
  await putChunks([
    ruleChunkSchema.parse({
      ...stampNewEntity(),
      bookId: book.id,
      chunkType: 'section',
      pageStart: 1,
      pageEnd: 1,
      headingPath: ['Combat', 'Grappling'],
      text: 'Grappling a creature rules text.',
      statBlock: null,
      contentHash: 'ab'.repeat(32),
    }),
  ]);

  // One generated module (spine + one ready part) — the board route sweep
  // and the reader both need a real module row.
  const moduleDraft = createModule({
    campaignId: campaign.id,
    title: 'Smoke Module',
    concept: 'A smoke-test module.',
    levelMin: 1,
    levelMax: 2,
    tone: '',
    sizeDial: 'standard',
  });
  await saveModule({
    ...moduleDraft,
    spine: moduleSpineSchema.parse({
      premise: 'The smoke premise.',
      themes: [],
      partPlan: [
        { title: 'Smoke Part', levelBand: '1', synopsis: 's', levelUpTrigger: 't' },
      ],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The [[Gorim]] smoke part body.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });

  return { campaignId: campaign.id, moduleId: moduleDraft.id };
}

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

beforeEach(async () => {
  await clearDatabase();
  useUiScaleStore.setState({ uiScale: DEFAULT_UI_SCALE });
  world = await seedSmokeWorld();
});

/** Renders the workspace and waits until every live query has resolved. */
async function renderSettledWorkspace(): Promise<void> {
  renderAppAt(workspacePath(world.campaignId));
  // Every kind section renders with its count; the persona panel mounts last
  // (settings live query). Interacting before that can race the tree's initial
  // re-renders (resizable group layout init).
  for (const name of Object.values(KIND_NAMES)) {
    await screen.findByText(name);
  }
  await screen.findByTestId('persona-panel');
}

describe('route smoke sweep', () => {
  it('campaign picker mounts with the seeded campaign and opens the create dialog', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.campaignPicker);

    expect(screen.getByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    expect(await screen.findByText('Smoke')).toBeInTheDocument();

    await user.click(screen.getByTestId('new-campaign'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it(
    'workspace tree shows every kind, filters, collapses, and tooltips rows',
    { timeout: 30_000 },
    async () => {
    const user = userEvent.setup();
    await renderSettledWorkspace();

    // Filter narrows to matching rows only. Driven via fireEvent because
    // react-resizable-panels' window-level pointerdown handler steals focus
    // onto a resize handle under jsdom's all-zero element rects, so
    // userEvent typing cannot reach inputs inside the panel group (a jsdom
    // artifact — real browsers hit-test correctly; docs/08-TESTING.md).
    const filter = screen.getByLabelText('Filter artifacts');
    fireEvent.change(filter, { target: { value: 'Gorim' } });
    await waitFor(
      () => {
        expect(screen.queryByText('Old Docks')).not.toBeInTheDocument();
      },
      { timeout: 5_000 },
    );
    expect(screen.getByText('Gorim')).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: '' } });
    await waitFor(
      () => {
        expect(screen.getByText('Old Docks')).toBeInTheDocument();
      },
      { timeout: 5_000 },
    );

    // Collapsing a section hides its rows but keeps the count badge.
    await user.click(screen.getByRole('button', { name: /NPCs/ }));
    await waitFor(() => {
      expect(screen.queryByText('Gorim')).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /NPCs/ }));
    expect(await screen.findByText('Gorim')).toBeInTheDocument();

    // Hovering a row renders the summary tooltip (anchors the tooltip to the
    // composed TooltipTrigger/ContextMenuTrigger element — see 08-TESTING).
    // Base UI's popup carries no tooltip role; assert on its content.
    await user.hover(screen.getByText('Gorim'));
    expect(
      await screen.findByText('Summary of Gorim', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();

    // The "Wiki-link graph" affordance renders the router Link (nativeButton=false
    // fix) — Base UI gives non-native button renders role="button".
    expect(screen.getByRole('button', { name: 'Wiki-link graph' })).toHaveAttribute(
      'href',
      graphPath(world.campaignId),
    );
    },
  );

  it('tree context menu opens and the rename dialog opens and closes', async () => {
    const user = userEvent.setup();
    await renderSettledWorkspace();

    const row = screen.getByText('Gorim').parentElement;
    if (row?.dataset.baseUiTooltipTrigger === undefined) {
      throw new Error('tree row trigger not found');
    }
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu');
    for (const item of ['Rename', 'Duplicate', 'Export as JSON', 'Delete']) {
      expect(within(menu).getByRole('menuitem', { name: item })).toBeInTheDocument();
    }

    await user.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Artifact name')).toHaveValue('Gorim');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('opens the artifact editor for every kind from the tree', async () => {
    const user = userEvent.setup();
    await renderSettledWorkspace();

    for (const name of Object.values(KIND_NAMES)) {
      await user.click(await screen.findByText(name));
      const editor = await screen.findByTestId('artifact-editor', {}, { timeout: 5_000 });
      expect(
        within(editor).getByTestId<HTMLInputElement>('artifact-name'),
      ).toHaveValue(name);
      // Leave the editor so the next kind mounts fresh.
      expect(screen.getByTestId('revision-badge').textContent).toBe('rev 1');
    }
  }, 20000);

  it('opens quick-find on the workspace and closes it', async () => {
    const user = userEvent.setup();
    await renderSettledWorkspace();

    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByTestId('quickfind-dialog', {}, { timeout: 5_000 })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('quickfind-dialog')).not.toBeInTheDocument();
    });
  });

  it('runs tab lists the seeded completed run', async () => {
    const user = userEvent.setup();
    await renderSettledWorkspace();

    await user.click(await screen.findByRole('tab', { name: 'Runs' }));
    const runs = await screen.findByTestId('runs-list');
    expect(within(runs).getByText('a smoke-test run')).toBeInTheDocument();
    expect(within(runs).getByText('completed')).toBeInTheDocument();
  });

  it('graph page mounts with the router Link back affordance', async () => {
    renderAppAt(graphPath(world.campaignId));

    expect(await screen.findByText('Wiki-link graph')).toBeInTheDocument();
    // Base UI gives non-native button renders role="button"; the href pins
    // the element to the router Link (nativeButton=false fix).
    expect(screen.getByRole('button', { name: 'Back to workspace' })).toHaveAttribute(
      'href',
      workspacePath(world.campaignId),
    );
  });

  it('module board route mounts with cards and the attribution badge', async () => {
    renderAppAt(boardPath(world.campaignId, world.moduleId));

    expect(await screen.findByTestId('board-premise-card', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByTestId('board-part-0')).toBeInTheDocument();
    // React Flow attribution: rendered by default, never hidden.
    expect(document.querySelector('.react-flow__attribution')).not.toBeNull();
  });

  it('module canvas route mounts with the part editor', async () => {
    renderAppAt(canvasPath(world.campaignId, world.moduleId));

    expect(await screen.findByTestId('module-canvas', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByTestId('canvas-part-select')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-editor')).toBeInTheDocument();
  });

  it('retired play route falls through to 404', async () => {
    renderAppAt(`/c/${world.campaignId}/play`);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('deliverables page mounts', async () => {
    renderAppAt(deliverablesPath(world.campaignId));

    expect(await screen.findByTestId('deliverables-page', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New deliverable' })).toBeInTheDocument();
  });

  it('rules page mounts with the seeded book', async () => {
    renderAppAt(ROUTES.rules);

    expect(screen.getByRole('heading', { name: 'Rulebooks' })).toBeInTheDocument();
    expect(await screen.findByText('Smoke Book', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import PDFs' })).toBeInTheDocument();
  });

  it('settings page mounts with the Appearance card and applies the UI scale', async () => {
    const user = userEvent.setup();
    renderAppAt(ROUTES.settings);

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();

    // The sync hook applied the default (100% → root var '1') on mount.
    expect(screen.getByTestId('ui-scale')).toHaveTextContent('100%');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1');

    // Exactly the six spec steps, in order.
    await user.click(screen.getByTestId('ui-scale'));
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['90%', '100%', '110%', '125%', '150%', '200%']);

    // Selecting 200% applies the factor to the document root (useUiScaleSync).
    await user.click(screen.getByRole('option', { name: '200%' }));
    expect(useUiScaleStore.getState().uiScale).toBe(2);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('2');
  });

  it('unknown routes render the not-found page', () => {
    renderAppAt('/definitely-not-a-route');

    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
