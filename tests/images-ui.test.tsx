import 'fake-indexeddb/auto';

import { act, render, screen, waitFor } from '@testing-library/react';
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
import { clearDatabase } from './db/helpers';
import { flushAsyncUpdates } from './helpers/flush';

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

    // It is already the cover → "Set as cover" is disabled.
    expect(screen.getByRole('button', { name: /Cover image/ })).toBeDisabled();
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

  it('encounter battlemap action pre-selects the Cartographer regeneration flow', async () => {
    const user = userEvent.setup();
    await seedBuiltInPersonas();
    await saveSettings({ ...defaultSettings(), openRouterApiKey: 'test-key' });
    const campaign = await createCampaign({ name: 'Maps', system: 'dnd5e' });
    const encounter = await createArtifact({
      campaignId: campaign.id,
      kind: 'encounter',
      name: 'Bridge Ambush',
    });
    renderAppAt(artifactPath(campaign.id, encounter.id));

    await user.click(await screen.findByTestId('generate-encounter-map'));
    const personaSelect = await screen.findByRole('combobox', { name: 'Persona' });
    await waitFor(() => {
      expect(personaSelect.textContent).toContain('Encounter Cartographer');
    });
    expect(screen.getByTestId('encounter-regenerate-target')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Map aspect' })).toBeInTheDocument();
    expect(screen.getByTestId('start-run')).toBeEnabled();
    await flushAsyncUpdates();
  }, 20000);

  it('settings expose the image generation toggle and model', async () => {
    renderAppAt('/settings');
    const toggle = await screen.findByTestId('images-enabled');
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText('Image model')).toHaveValue('google/gemini-2.5-flash-image');

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
