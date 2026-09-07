import 'fake-indexeddb/auto';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { artifactPath, modulePath } from '@/app/routes';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { seedBattleFromEncounter } from '@/db/battleSeed';
import { createCampaign } from '@/db/campaignRepo';
import { createModule as saveModule } from '@/db/moduleRepo';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  statBlockSchema,
  type Id,
  type StatBlock,
} from '@/domain';
import { BattleSurface } from '@/features/play/battle/BattleSurface';
import { ZoomableImage } from '@/features/images/zoomable-image';
import { clearDatabase } from './db/helpers';
import { flushAsyncUpdates } from './helpers/flush';

/**
 * iPad batch G — scroll chaining / overscroll (05-UI.md §Tablet): inner
 * scroll containers pin `overscroll-behavior: contain` so an iOS edge swipe
 * (or pull-to-refresh) inside the tree, the reader ToC/chapter, the entity
 * list, the peek modal body, or any dialog no longer yanks the page behind
 * them; the battle board and the image lightbox own all gestures by design
 * (`touch-none`) and pin `overscroll-behavior: none`. jsdom cannot measure
 * scrolling — class assertions are the accepted pattern here (the
 * module-reader reader-width precedent): each container must carry the
 * overscroll class alongside its overflow utility. Desktop rendering is
 * untouched (overscroll-behavior is a no-op where no chaining occurs).
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));

vi.mock('@/llm/moduleGen', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
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

function statBlock(over: Partial<StatBlock> = {}): StatBlock {
  return statBlockSchema.parse({
    system: 'dnd5e',
    level: '1',
    size: 'Medium',
    creatureType: 'humanoid',
    ac: 12,
    acNote: '',
    hp: 10,
    hpFormula: '',
    speed: '30 ft.',
    abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    cr: '1/2',
    proficiency: 2,
    traits: [],
    actions: [],
    reactions: [],
    legendary: [],
    extras: {},
    ...over,
  });
}

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

async function seedReaderModule(): Promise<{ campaignId: Id; moduleId: Id }> {
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
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  const spine = moduleSpineSchema.parse({
    premise: 'The party recovers a relic from the [[Old Tower]].',
    themes: ['bargains'],
    partPlan: [
      {
        title: 'The Gate Bargain',
        levelBand: '1',
        synopsis: 'The party negotiates entry.',
        levelUpTrigger: 'The gate opens.',
      },
    ],
  });
  const saved = await saveModule({
    ...draft,
    status: 'ready',
    errorMessage: '',
    spine,
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown: 'The party climbs to the [[Old Tower]] before dawn.',
        status: 'ready',
        errorMessage: '',
        edited: false,
      }),
    ],
  });
  return { campaignId: campaign.id, moduleId: saved.id };
}

beforeEach(clearDatabase);

afterEach(async () => {
  await flushAsyncUpdates(20);
  cleanup();
  vi.clearAllMocks();
});

describe('dialog primitive', () => {
  it('chains no scroll through dialog content (overscroll-contain)', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Chained dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const content = screen.getByRole('dialog');
    expect(content.className).toContain('overflow-y-auto');
    expect(content.className).toContain('overscroll-contain');
  });
});

describe('image lightbox layer', () => {
  it('owns all gestures on the zoomable image (overscroll-none)', () => {
    render(<ZoomableImage imageId="missing-image" />);

    const layer = screen.getByTestId('zoomable-image');
    expect(layer.className).toContain('touch-none');
    expect(layer.className).toContain('overscroll-none');
  });
});

describe('campaign tree scroll region', () => {
  it('contains overscroll inside the tree list', async () => {
    const { campaignId } = await seedReaderModule();
    const tower = (await listArtifactsByCampaign(campaignId)).find(
      (artifact) => artifact.name === 'Old Tower',
    );
    if (tower === undefined) throw new Error('Old Tower artifact missing from the seed');
    renderAppAt(artifactPath(campaignId, tower.id));

    const tree = await screen.findByLabelText('Campaign tree', {}, { timeout: 10_000 });
    const scroller = tree.querySelector('.flex-1.overflow-y-auto');
    if (scroller === null) throw new Error('campaign tree scroll region missing');
    expect(scroller.className).toContain('overscroll-contain');
    await flushAsyncUpdates();
  }, 20_000);
});

describe('module reader scroll regions', () => {
  it('contains overscroll in the ToC, the chapter scroll, and the entity list', async () => {
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    const toc = await screen.findByTestId('module-toc', {}, { timeout: 10_000 });
    expect(toc.className).toContain('overflow-y-auto');
    expect(toc.className).toContain('overscroll-contain');

    const reader = screen.getByTestId('module-reader');
    const chapter = reader.querySelector(':scope > .min-h-0.flex-1.overflow-y-auto');
    if (chapter === null) throw new Error('module reader chapter scroll region missing');
    expect(chapter.className).toContain('overscroll-contain');

    const panel = await screen.findByTestId('entity-panel', {}, { timeout: 10_000 });
    const list = panel.querySelector('.flex-1.overflow-y-auto');
    if (list === null) throw new Error('entity panel list scroll region missing');
    expect(list.className).toContain('overscroll-contain');
    await flushAsyncUpdates();
  }, 20_000);

  it('contains overscroll in the peek modal body', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    const rows = await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
    const towerRow = rows.find((row) => row.textContent.includes('Old Tower'));
    if (towerRow === undefined) throw new Error('Old Tower row not found in the entity panel');
    await user.click(towerRow);

    const peek = await screen.findByTestId('peek-modal', {}, { timeout: 5_000 });
    const body = peek.querySelector('.flex-1.overflow-y-auto');
    if (body === null) throw new Error('peek modal body scroll region missing');
    expect(body.className).toContain('overscroll-contain');
    await flushAsyncUpdates();
  }, 20_000);
});

describe('battle board layer', () => {
  it('owns all gestures on the board (overscroll-none)', async () => {
    const campaign = await createCampaign({ name: 'Battle UI', system: 'dnd5e' });
    const campaignId = campaign.id;
    await createArtifact({
      campaignId,
      kind: 'pc',
      name: 'Serren',
      data: {
        playerName: '',
        statBlock: statBlock({ hp: 20 }),
        currentHp: 20,
        initiativeOverride: null,
        notes: '',
      },
    });
    const npc = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Troll',
      data: {
        appearance: '',
        personality: '',
        statBlock: statBlock({ hp: 84 }),
      },
    });
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Bridge ambush',
      data: {
        difficulty: 'deadly',
        levelHint: '5',
        monsters: [
          {
            name: 'Troll',
            count: 1,
            notes: '',
            treasure: '',
            source: { type: 'npc-ref', artifactId: npc.id },
          },
        ],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    const module = await saveModule(
      createModule({
        campaignId,
        title: 'Battle Module',
        concept: '',
        levelMin: 1,
        levelMax: 5,
        sizeDial: 'sketch',
      }),
    );
    await seedBattleFromEncounter(campaignId, module.id, encounter.id);

    render(
      <MemoryRouter initialEntries={[`/c/${campaignId}/m/${module.id}/battle`]}>
        <Routes>
          <Route path="/c/:campaignId/m/:moduleId/battle" element={<BattleSurface />} />
        </Routes>
      </MemoryRouter>,
    );

    const board = await screen.findByTestId('battle-board', {}, { timeout: 10_000 });
    expect(board.className).toContain('touch-none');
    expect(board.className).toContain('overscroll-none');
    await flushAsyncUpdates(20);
  }, 30_000);
});
