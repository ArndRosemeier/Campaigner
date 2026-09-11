import 'fake-indexeddb/auto';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '@/app/router';
import { artifactPath } from '@/app/routes';
import { createArtifact, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage, getImage } from '@/db/imageRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { readSettings, saveSettings, updateSettings } from '@/db/settingsRepo';
import { defaultSettings } from '@/domain';
import { db } from '@/db/db';
import { toastSuccess } from '@/lib/toast';
import { clearDatabase } from './db/helpers';
import { flushAsyncUpdates } from './helpers/flush';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const toastSuccessMock = vi.mocked(toastSuccess);

/**
 * Images UI (07-MILESTONE-3 M3-A §UI): tree cover thumbnail, editor Images
 * section (gallery + lightbox delete), and the "Illustrate…" hand-off that
 * pre-selects the Illustrator persona with the artifact as target.
 */

let createObjectUrlMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom lacks object URL support; the hooks revoke what they create.
  createObjectUrlMock = vi.fn(() => `blob:mock-${Math.random()}`);
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectUrlMock,
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  toastSuccessMock.mockClear();
  return clearDatabase();
});

async function seedWithImage(): Promise<{ artifactPath: string; imageId: string; campaignId: string }> {
  await seedBuiltInPersonas();
  await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
  const campaign = await createCampaign({ name: 'Imagery', system: 'generic-d20' });
  const image = await createImage({
    campaignId: campaign.id,
    blob: new Blob(['img-bytes'], { type: 'image/webp' }),
    mimeType: 'image/webp',
    width: 64,
    height: 64,
    prompt: 'a tower',
    model: 'google/gemini-2.5-flash-image',
    source: 'generated',
  });
  const artifact = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
  });
  await updateArtifact(artifact.id, { imageIds: [image.id], coverImageId: image.id });
  return {
    artifactPath: artifactPath(campaign.id, artifact.id),
    imageId: image.id,
    campaignId: campaign.id,
  };
}

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

describe('images ui', () => {
  it('shows the cover thumbnail in the tree and the gallery in the editor', async () => {
    const { artifactPath: path } = await seedWithImage();
    renderAppAt(path);

    expect(await screen.findByAltText('Cover of Old Tower', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(screen.getByTestId('images-section')).toBeInTheDocument();
    // The gallery resolves its own image live query a tick after the tree
    // thumbnail — never assert on it synchronously.
    expect(
      await screen.findByAltText('Artifact image', {}, { timeout: 5_000 }),
    ).toHaveAttribute('src', expect.stringMatching(/^blob:mock-/));
    expect(screen.getByRole('button', { name: /Illustrate/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload/ })).toBeInTheDocument();
    await flushAsyncUpdates();
  });

  it('deletes an image from the lightbox, clearing the live references (blob survives via history)', async () => {
    const user = userEvent.setup();
    const { artifactPath: path, imageId, campaignId } = await seedWithImage();
    renderAppAt(path);

    await screen.findByAltText('Artifact image', {}, { timeout: 5_000 });
    await user.click(screen.getByRole('button', { name: /Open image/ }));
    expect(await screen.findByAltText('Artifact image, large view')).toBeInTheDocument();

    // It is already the cover → a non-interactive status chip, never a
    // disabled button (a disabled Button reads as a broken control).
    expect(screen.getByTestId('artifact-image-cover-status')).toHaveTextContent('Cover image');
    expect(screen.queryByRole('button', { name: /cover/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Delete/ }));

    await waitFor(
      () => {
        expect(screen.getByText(/No images yet/)).toBeInTheDocument();
      },
      { timeout: 5_000 },
    );
    await waitFor(
      () => {
        expect(screen.queryByAltText('Cover of Old Tower')).not.toBeInTheDocument();
      },
      { timeout: 5_000 },
    );
    // Drain the delete's live-query cascade inside act before plain reads.
    await flushAsyncUpdates();
    // The live artifact lost its references…
    const artifacts = await act(async () => db.artifacts.toArray());
    expect(artifacts[0]?.imageIds).toEqual([]);
    expect(artifacts[0]?.coverImageId).toBeNull();
    // …and the blob is freed: a user-initiated delete scrubs the id from
    // this artifact's revision snapshots too (M4-C amendment), so a restore
    // shows the entity without the deleted image instead of dangling.
    await waitFor(
      async () => {
        expect(await getImage(imageId)).toBeUndefined();
      },
      { timeout: 5_000 },
    );
    void campaignId;
    await flushAsyncUpdates();
  });

  it('opens the artifact lightbox fullscreen: viewport-filling dialog, image fills the reserved box (contain, upscale allowed), footer strip intact', async () => {
    const user = userEvent.setup();
    const { artifactPath: path } = await seedWithImage();
    renderAppAt(path);

    await screen.findByAltText('Artifact image', {}, { timeout: 5_000 });
    await user.click(screen.getByRole('button', { name: /Open image/ }));
    const dialog = await screen.findByTestId('artifact-image-lightbox', {}, { timeout: 5_000 });
    // jsdom cannot measure pixels — class assertions are the accepted pattern
    // here (the module-reader reader-width precedent): the dialog must be
    // edge-to-edge, not the old max-w-2xl box.
    expect(dialog.className).toContain('h-dvh');
    expect(dialog.className).toContain('w-dvw');
    expect(dialog.className).toContain('max-w-none');
    expect(dialog.className).toContain('rounded-none');
    expect(dialog.className).toContain('bg-black/90');
    expect(dialog.className).not.toContain('max-w-2xl');
    const image = await screen.findByAltText('Artifact image, large view');
    // Fill contract: the img owns the whole reserved box (`h-… w-full`), so
    // object-contain can scale UP past natural size — shrink-only max-* caps
    // (or `w-auto`) render a 1024×1024 image at half a big screen.
    expect(image.className).toContain('object-contain');
    expect(image.className).toContain('h-[calc(100dvh-6rem)]');
    expect(image.className).toContain('w-full');
    expect(image.className).toContain('max-h-[100dvh]');
    expect(image.className).not.toContain('w-auto');
    expect(image.className).not.toContain('max-h-96');
    // The bottom overlay strip keeps the metadata line and the actions.
    const footer = screen.getByTestId('artifact-image-lightbox-footer');
    expect(footer.textContent).toContain('64×64 · image/webp · generated');
    // PROVENANCE (docs/17 row 93): the image MODEL is stated exactly once in
    // this dialog — as the caption under the image (the owner's requested
    // shape), not duplicated into the metadata line above the actions.
    expect(await screen.findByTestId('lightbox-image-model')).toHaveTextContent(
      'google/gemini-2.5-flash-image',
    );
    expect(footer.textContent).not.toContain('google/gemini-2.5-flash-image');
    // The seeded image is already the cover → a status chip, not a button.
    expect(within(footer).getByTestId('artifact-image-cover-status')).toHaveTextContent('Cover image');
    expect(within(footer).queryByRole('button', { name: /cover/i })).not.toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: /Delete/ })).toBeInTheDocument();
    expect(footer.textContent).toContain('Prompt: a tower');
    await flushAsyncUpdates();
  });

  it('a non-cover image offers a working "Set as cover" that flips the footer to the status chip', async () => {
    const user = userEvent.setup();
    const { artifactPath: path, imageId: coverId, campaignId } = await seedWithImage();
    const second = await createImage({
      campaignId,
      blob: new Blob(['img-bytes-2'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 128,
      height: 96,
      source: 'uploaded',
    });
    const [artifact] = await db.artifacts.toArray();
    if (artifact === undefined) throw new Error('seeded artifact missing');
    await updateArtifact(artifact.id, { imageIds: [coverId, second.id], coverImageId: coverId });
    renderAppAt(path);

    await screen.findByRole('button', { name: /Open image 128/ }, { timeout: 5_000 });
    await user.click(screen.getByRole('button', { name: /Open image 128/ }));
    expect(await screen.findByAltText('Artifact image, large view')).toBeInTheDocument();

    // Non-cover → the action button is present and enabled; no status chip.
    const setCover = await screen.findByRole('button', { name: /Set as cover/ });
    expect(setCover).toBeEnabled();
    expect(screen.queryByTestId('artifact-image-cover-status')).not.toBeInTheDocument();
    await user.click(setCover);

    // The footer flips to the non-interactive status chip and the row persists.
    expect(await screen.findByTestId('artifact-image-cover-status')).toHaveTextContent('Cover image');
    expect(toastSuccessMock).toHaveBeenCalledWith('Cover image set');
    await waitFor(
      async () => {
        const [next] = await db.artifacts.toArray();
        expect(next?.coverImageId).toBe(second.id);
      },
      { timeout: 5_000 },
    );
    await flushAsyncUpdates();
  });

  it('"Illustrate…" pre-selects the Illustrator persona with the artifact as target', async () => {
    const user = userEvent.setup();
    const { artifactPath: path } = await seedWithImage();
    renderAppAt(path);

    await screen.findByAltText('Artifact image', {}, { timeout: 5_000 });
    await user.click(screen.getByRole('button', { name: /Illustrate/ }));

    // The persona select now shows Illustrator and the target select is set.
    const personaSelect = await screen.findByRole('combobox', { name: 'Persona' });
    expect(personaSelect.textContent).toContain('Illustrator');
    const targetSelect = await screen.findByRole('combobox', { name: 'Artifact to illustrate' });
    expect(targetSelect.textContent).toContain('Old Tower');
    expect(screen.getByTestId('start-run')).toBeEnabled();
  }, 20000);

  it('encounter editor shows exactly two automatic actions plus the prose checkbox (no per-section generate buttons)', async () => {
    await seedBuiltInPersonas();
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
    const campaign = await createCampaign({ name: 'Maps', system: 'dnd5e' });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Bridge Ambush',
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
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
    renderAppAt(artifactPath(campaign.id, encounter.id));

    const section = await screen.findByTestId('encounter-ai-section');
    // The two automatic actions, verbatim labels…
    expect(within(section).getByTestId('encounter-regenerate-everything')).toHaveTextContent(
      'Regenerate everything',
    );
    expect(within(section).getByTestId('encounter-repopulate')).toHaveTextContent('Repopulate');
    // …plus the prose checkbox, default OFF.
    const checkbox = within(section).getByTestId('encounter-redesign-prose');
    expect(checkbox).toHaveTextContent('');
    expect(section).toHaveTextContent('Also redesign name and prose');
    // The old per-section hand-offs are gone: no map button, no content button.
    expect(screen.queryByTestId('generate-encounter-map')).not.toBeInTheDocument();
    expect(screen.queryByTestId('generate-encounter-content')).not.toBeInTheDocument();
    // The battlemap section still offers Upload + the no-map note.
    expect(screen.getByTestId('upload-battlemap')).toBeInTheDocument();
    expect(screen.getByText(/No battlemap/)).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20000);

  it('repopulate is disabled for a roomless complex (regenerate-everything builds rooms first)', async () => {
    await seedBuiltInPersonas();
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
    const campaign = await createCampaign({ name: 'Roomless', system: 'dnd5e' });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Empty Halls',
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'dungeon',
        locationKind: 'dungeon',
        siteShape: 'complex',
        budgetAdvisory: '',
      },
    });
    renderAppAt(artifactPath(campaign.id, encounter.id));

    const section = await screen.findByTestId('encounter-ai-section');
    expect(within(section).getByTestId('encounter-regenerate-everything')).toBeEnabled();
    expect(within(section).getByTestId('encounter-repopulate')).toBeDisabled();
    await flushAsyncUpdates();
  }, 20000);

  it('battlemap section keeps Upload + Clear, states the two-action contract and the fresh-keys note', async () => {
    await seedBuiltInPersonas();
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
    const campaign = await createCampaign({ name: 'Maps II', system: 'dnd5e' });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Bridge Ambush II',
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
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
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['map-bytes'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 2304,
      height: 1728,
      source: 'generated',
      role: 'map',
    });
    await updateArtifact(encounter.id, {
      imageIds: [image.id],
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: image.id,
        layout: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    renderAppAt(artifactPath(campaign.id, encounter.id));

    // No standalone generate button — Upload + Clear stay.
    expect(await screen.findByTestId('upload-battlemap')).toBeInTheDocument();
    expect(screen.getByTestId('clear-battlemap')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-encounter-map')).not.toBeInTheDocument();
    // The contract copy names both actions; the keys note names Regenerate everything.
    expect(screen.getByTestId('battlemap-section')).toHaveTextContent('Regenerate everything builds a');
    expect(screen.getByTestId('regenerate-keys-note')).toHaveTextContent(
      'Regenerate everything writes fresh room keys',
    );
    // The editor shows the map on file instead of the "no battlemap" note.
    expect(screen.getByRole('button', { name: 'Open battlemap' })).toBeInTheDocument();
    expect(screen.queryByText(/No battlemap/)).not.toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20000);

  it('a dungeon-preset encounter captions the map as a Dungeon layout', async () => {
    await seedBuiltInPersonas();
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
    const campaign = await createCampaign({ name: 'Dungeons', system: 'dnd5e' });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Drowned Halls',
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        layout: null,
        preset: 'dungeon',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    const image = await createImage({
      campaignId: campaign.id,
      blob: new Blob(['map-bytes'], { type: 'image/webp' }),
      mimeType: 'image/webp',
      width: 2304,
      height: 1728,
      source: 'generated',
      role: 'map',
    });
    await updateArtifact(encounter.id, {
      imageIds: [image.id],
      data: {
        difficulty: '',
        levelHint: '',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: image.id,
        layout: null,
        preset: 'dungeon',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
      },
    });
    renderAppAt(artifactPath(campaign.id, encounter.id));

    // The map caption names the preset (the layout is the encounter's identity).
    expect(await screen.findByText(/Dungeon layout on file/)).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20000);

  it('settings expose the image generation toggle and model', async () => {
    renderAppAt('/settings');
    const toggle = await screen.findByTestId('images-enabled');
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText('First-try image model')).toHaveValue('google/gemini-2.5-flash-image');

    const user = userEvent.setup();
    await user.click(toggle);
    await waitFor(() => {
      void expect(readSettings()).resolves.toMatchObject({ imagesEnabled: true });
    });
    // The write re-fires the settings live query — keep it inside act.
    await act(async () => {
      await updateSettings({ imagesEnabled: false });
    });
    await flushAsyncUpdates();
  });});
