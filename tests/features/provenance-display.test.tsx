import 'fake-indexeddb/auto';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { modulePath } from '@/app/routes';
import { createArtifact, listArtifactsByCampaign, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Id,
  type Module,
  type StoredImage,
} from '@/domain';
import { NpcCard } from '@/features/play/artifact-cards';
import { LightboxImage } from '@/features/images/lightbox-image';
import { ModuleCoverHero } from '@/features/covers/cover-art';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * PROVENANCE (owner request, docs/17 row 93): the DISPLAY half — "a very
 * small id below generated texts (in entity cards and the module) … and a
 * small id below images indicating the image model", APP ONLY.
 *
 * Recording is pinned by `tests/llm/provenance-recording.test.ts`; export
 * exclusion by `tests/lib/provenance-export.test.ts`. This file pins what the
 * owner SEES: the id's own surface on each display it was asked for, and —
 * just as load-bearing — that a row with nothing recorded renders nothing at
 * all rather than a placeholder or a settings-derived guess.
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

const SPINE_MODEL = 'staged/spine-model';
const PART_MODEL = 'staged/part-model';
const NPC_MODEL = 'staged/npc-model';
const IMAGE_MODEL = 'black-forest-labs/flux-1.1-pro';

/** jsdom has no object URLs; `useImageUrl` revokes what it creates. */
function stubObjectUrls(): void {
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => `blob:mock-${String(Math.random())}`),
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
}

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

/**
 * A reader module whose spine/part rows carry provenance — exactly the shape
 * the generator writes. `legacy` drops both ids, standing in for a module
 * written before the field existed.
 */
async function seedReaderModule(
  options: { legacy?: boolean } = {},
): Promise<{ campaign: Campaign; campaignId: Id; moduleId: Id }> {
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
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  const spine = moduleSpineSchema.parse({
    premise: 'The party is hired to recover a drowned relic from the [[Old Tower]].',
    themes: ['bargains'],
    partPlan: [
      {
        title: 'The Gate Bargain',
        levelBand: '1',
        synopsis: 'The party negotiates entry with the tower keeper.',
        levelUpTrigger: 'The gate opens.',
      },
    ],
    ...(options.legacy === true ? {} : { writerModel: SPINE_MODEL }),
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
        ...(options.legacy === true ? {} : { writerModel: PART_MODEL }),
      }),
    ],
  });
  return { campaign, campaignId: campaign.id, moduleId: saved.id };
}

/** The reader mounts asynchronously; every test waits for it first. */
async function findReader(): Promise<HTMLElement> {
  return screen.findByTestId('module-reader', {}, { timeout: 10_000 });
}

beforeEach(clearDatabase);
afterEach(() => {
  vi.restoreAllMocks();
});

describe('the module reader shows the writing model', () => {
  it('prints the premise model under the premise and the part model under the part', async () => {
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));
    await findReader();

    const premise = await screen.findByTestId('premise-writer-model');
    expect(premise).toHaveTextContent(SPINE_MODEL);
    const part = await screen.findByTestId('part-writer-model');
    expect(part).toHaveTextContent(PART_MODEL);
    // …and the ids are the real recorded ones, not swapped or shared.
    expect(part).not.toHaveTextContent(SPINE_MODEL);
    await flushAsyncUpdates();
  }, 20_000);

  it('renders NOTHING for a module written before the field (no placeholder, no guess)', async () => {
    const { campaignId, moduleId } = await seedReaderModule({ legacy: true });
    renderAppAt(modulePath(campaignId, moduleId));
    await findReader();
    // The premise and the part both render; their ids simply do not exist.
    expect(await screen.findByTestId('part-body')).toBeInTheDocument();
    expect(screen.queryByTestId('premise-writer-model')).not.toBeInTheDocument();
    expect(screen.queryByTestId('part-writer-model')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);
});

describe('the entity card shows the writing model and the image model', () => {
  it('prints both ids in the peek modal — text id and image id', async () => {
    stubObjectUrls();
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    const tower = (await listArtifactsByCampaign(campaignId)).find(
      (artifact) => artifact.name === 'Old Tower',
    );
    if (tower === undefined) throw new Error('Old Tower artifact missing from the seed');
    const generated = await createImage({
      campaignId,
      blob: new Blob(['tower-art'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      prompt: 'a leaning watchtower',
      model: IMAGE_MODEL,
      source: 'generated',
    });
    await updateArtifact(tower.id, {
      imageIds: [generated.id],
      coverImageId: generated.id,
      writerModel: NPC_MODEL,
    });

    renderAppAt(modulePath(campaignId, moduleId));
    const rows = await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
    const towerRow = rows.find((row) => row.textContent.includes('Old Tower'));
    if (towerRow === undefined) throw new Error('Old Tower row not found in the entity panel');
    await user.click(towerRow);

    const peek = await screen.findByTestId('peek-modal', {}, { timeout: 5_000 });
    // The writing model, under the card's text.
    expect(await within(peek).findByTestId('peek-writer-model')).toHaveTextContent(NPC_MODEL);
    // The IMAGE model, under the card's image — the owner's second half.
    expect(within(peek).getByTestId('peek-image-model')).toHaveTextContent(IMAGE_MODEL);
    await flushAsyncUpdates();
  }, 20_000);

  it('renders no image id for an uploaded image in the same card', async () => {
    stubObjectUrls();
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    const tower = (await listArtifactsByCampaign(campaignId)).find(
      (artifact) => artifact.name === 'Old Tower',
    );
    if (tower === undefined) throw new Error('Old Tower artifact missing from the seed');
    const uploaded = await createImage({
      campaignId,
      blob: new Blob(['my-own-painting'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      model: '',
      source: 'uploaded',
    });
    await updateArtifact(tower.id, { imageIds: [uploaded.id], coverImageId: uploaded.id });

    renderAppAt(modulePath(campaignId, moduleId));
    const rows = await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
    const towerRow = rows.find((row) => row.textContent.includes('Old Tower'));
    if (towerRow === undefined) throw new Error('Old Tower row not found in the entity panel');
    await user.click(towerRow);

    const peek = await screen.findByTestId('peek-modal', {}, { timeout: 5_000 });
    expect(within(peek).getByTestId('peek-image')).toBeInTheDocument();
    // The image is there; its id is not — nothing was recorded for an upload.
    expect(within(peek).queryByTestId('peek-image-model')).not.toBeInTheDocument();
    expect(within(peek).queryByTestId('peek-writer-model')).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);

  it('the shared NpcCard shows the id only when the surface opts in', async () => {
    const campaign = await createCampaign({ name: 'Cards', system: 'dnd5e' });
    const npc = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Silt Warden',
      summary: 'Collects the toll.',
      writerModel: NPC_MODEL,
    });
    if (npc.kind !== 'npc') throw new Error('npc artifact expected');

    // Default (battle table's GM-only card): NO provenance.
    const plain = render(<NpcCard npc={npc} />);
    expect(plain.queryByTestId('npc-card-writer-model')).not.toBeInTheDocument();
    plain.unmount();

    // The entity card opts in.
    render(<NpcCard npc={npc} showWriterModel />);
    expect(screen.getByTestId('npc-card-writer-model')).toHaveTextContent(NPC_MODEL);
  });
});

describe('image surfaces show the image model', () => {
  it('the lightbox captions a generated image and stays silent for an upload', async () => {
    stubObjectUrls();
    const campaign = await createCampaign({ name: 'Images', system: 'dnd5e' });
    const generated = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['generated'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      model: IMAGE_MODEL,
      source: 'generated',
    });
    const uploaded = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['uploaded'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      model: '',
      source: 'uploaded',
    });

    const first = render(<LightboxImage imageId={generated.id} />);
    expect(await screen.findByTestId('lightbox-image-model')).toHaveTextContent(IMAGE_MODEL);
    first.unmount();

    render(<LightboxImage imageId={uploaded.id} />);
    await waitFor(() => {
      expect(screen.getByRole('img')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('lightbox-image-model')).not.toBeInTheDocument();
  });

  it('the cover hero captions its own image, and a cover-less module keeps its shape', async () => {
    stubObjectUrls();
    const campaign = await createCampaign({ name: 'Covers', system: 'dnd5e' });
    const image: StoredImage = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['cover'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 16,
      height: 9,
      model: IMAGE_MODEL,
      source: 'generated',
    });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'A Covered Module',
      concept: '',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'sketch',
    });
    const withCover = await saveModule({ ...draft, coverImageId: image.id });

    const first = render(<ModuleCoverHero module={withCover} />);
    expect(await screen.findByTestId('module-cover-hero-model')).toHaveTextContent(IMAGE_MODEL);
    first.unmount();

    const bare = await saveModule({ ...draft, coverImageId: null });
    const second = render(<ModuleCoverHero module={bare} />);
    expect(screen.queryByTestId('module-cover-hero')).not.toBeInTheDocument();
    expect(screen.queryByTestId('module-cover-hero-model')).not.toBeInTheDocument();
    second.unmount();
  });

  it('a stored module keeps its recorded provenance across a reload', async () => {
    const { moduleId } = await seedReaderModule();
    const reloaded: Module | undefined = await getModule(moduleId);
    expect(reloaded?.spine?.writerModel).toBe(SPINE_MODEL);
    expect(reloaded?.parts[0]?.writerModel).toBe(PART_MODEL);
  });
});
