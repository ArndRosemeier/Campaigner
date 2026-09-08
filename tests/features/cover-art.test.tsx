import 'fake-indexeddb/auto';

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { modulePath, modulesPath, ROUTES } from '@/app/routes';
import { createCampaign, updateCampaign } from '@/db/campaignRepo';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { createImage } from '@/db/imageRepo';
import { createModule as saveModuleRow, patchModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { createModule, type Id } from '@/domain';
import { clearDatabase } from '../db/helpers';

/**
 * Cover art displays (cover-generation arc): every surface mounts its slot
 * through `useImageUrl(coverImageId)` — thumb (list), hero (reader), card
 * art (picker) — with the Generate affordance beside it. Cover-less rows
 * mount no art and keep their shape.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// The router graph pulls the module generator; generation never runs here.
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
  };
});

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

function renderPicker(): void {
  render(
    <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
      <Routes>
        <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
        <Route path="*" element={<div data-testid="navigated-away" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(async () => {
  // jsdom lacks object URL support; the hooks revoke what they create.
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock-cover'),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  await clearDatabase();
  await seedBuiltInPersonas();
});

afterEach(cleanup);

async function seedCampaignWithCover(name: string): Promise<Id> {
  const campaign = await createCampaign({ name, description: 'A city of ash.', system: 'dnd5e' });
  const image = await createImage({
    campaignId: campaign.id,
    blob: new Blob(['campaign-art'], { type: 'image/webp' }),
    mimeType: 'image/webp',
    width: 64,
    height: 64,
    prompt: '',
    model: '',
    source: 'generated',
  });
  await updateCampaign(campaign.id, { coverImageId: image.id });
  return campaign.id;
}

async function seedModuleWithCover(campaignId: Id, title: string): Promise<Id> {
  const module = await saveModuleRow(
    createModule({
      campaignId,
      title,
      concept: 'A whispering vault.',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard',
    }),
  );
  const image = await createImage({
    campaignId,
    blob: new Blob(['module-art'], { type: 'image/webp' }),
    mimeType: 'image/webp',
    width: 64,
    height: 64,
    prompt: '',
    model: '',
    source: 'generated',
  });
  await patchModule(module.id, { coverImageId: image.id });
  return module.id;
}

describe('cover art displays', () => {
  it('the module list row mounts the thumb with the generate affordance', async () => {
    const campaignId = await seedCampaignWithCover('Ember');
    await seedModuleWithCover(campaignId, 'Vault of Whispers');
    renderAppAt(modulesPath(campaignId));

    expect(await screen.findByTestId('module-cover-thumb')).toHaveAttribute('src', 'blob:mock-cover');
    expect(screen.getByAltText('Cover art for Vault of Whispers')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Regenerate cover for Vault of Whispers' }),
    ).toBeInTheDocument();
  });

  it('a cover-less module row mounts no thumb but keeps its generate affordance', async () => {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    await saveModuleRow(
      createModule({
        campaignId: campaign.id,
        title: 'Bare Module',
        concept: 'Nothing yet.',
        levelMin: 1,
        levelMax: 1,
        sizeDial: 'sketch',
      }),
    );
    renderAppAt(modulesPath(campaign.id));

    expect(await screen.findByText('Bare Module')).toBeInTheDocument();
    expect(screen.queryByTestId('module-cover-thumb')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Generate cover for Bare Module' }),
    ).toBeInTheDocument();
  });

  it('the reader header mounts the hero with the generate affordance', async () => {
    const campaignId = await seedCampaignWithCover('Ember');
    const moduleId = await seedModuleWithCover(campaignId, 'Vault of Whispers');
    renderAppAt(modulePath(campaignId, moduleId));

    expect(await screen.findByTestId('module-cover-hero')).toHaveAttribute('src', 'blob:mock-cover');
    expect(
      screen.getByRole('button', { name: 'Regenerate cover for Vault of Whispers' }),
    ).toBeInTheDocument();
  });

  it('the campaign picker card mounts the art with the generate affordance', async () => {
    await seedCampaignWithCover('Ember');
    renderPicker();

    expect(await screen.findByTestId('campaign-cover-art')).toHaveAttribute('src', 'blob:mock-cover');
    expect(screen.getByAltText('Cover art for Ember')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate cover for Ember' })).toBeInTheDocument();
  });
});
