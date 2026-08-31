import 'fake-indexeddb/auto';

import { render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByAltText('Artifact image')).toHaveAttribute('src', expect.stringMatching(/^blob:mock-/));
    expect(screen.getByRole('button', { name: /Illustrate/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload/ })).toBeInTheDocument();
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

    await waitFor(() => {
      expect(screen.getByText(/No images yet/)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByAltText('Cover of Old Tower')).not.toBeInTheDocument();
    });
    // The live artifact lost its references…
    const artifacts = await db.artifacts.toArray();
    expect(artifacts[0]?.imageIds).toEqual([]);
    expect(artifacts[0]?.coverImageId).toBeNull();
    // …but the blob survives: revision snapshots still reference it and a
    // restore would re-attach it (07-MILESTONE-3 M3-A: the reference check
    // covers artifacts AND revisions).
    expect(await getImage(imageId)).toBeDefined();

    // Deleting the whole artifact prunes the now-orphaned blobs.
    const { deleteArtifact } = await import('@/db/artifactRepo');
    await deleteArtifact(artifacts[0]?.id ?? '');
    await waitFor(async () => {
      expect(await getImage(imageId)).toBeUndefined();
    });
    void campaignId;
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
  });

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
    await updateSettings({ imagesEnabled: false });
  });});
