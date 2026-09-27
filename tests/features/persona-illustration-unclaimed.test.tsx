import 'fake-indexeddb/auto';

import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import type { AnyArtifact, Campaign } from '@/domain';
import { useIllustrationRequest } from '@/features/campaign/illustrationRequest';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';
import { renderPersonaPanel } from '../helpers/personaPanel';

/**
 * THE ILLUSTRATION HAND-OFF IS NEVER SILENTLY DROPPED (docs/17 row 376). This
 * is the THIRD instance of the defect class rows 374/375 fixed: the
 * illustration-request effect carried the same one-line conflation
 * (`personas?.find(persona => persona.slug === 'illustrator')` then a bare
 * `return`), so an install whose `illustrator` row is missing dropped the
 * owner's "Illustrate…" hand-off with no message AND left the request in
 * `useIllustrationRequest` forever.
 *
 * Both hand-offs now go through ONE decision seam
 * (`features/campaign/handoffPersona.resolveHandoffPersona`), and these pins
 * drive the REAL panel so the effect is provably mounted. The house error
 * surface `lib/toast.toastError` (already imported by the panel) is mocked, so
 * the toast is asserted by call rather than re-implemented.
 */
vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastInfoPersistent: vi.fn(),
}));

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

beforeEach(async () => {
  await clearDatabase();
  useIllustrationRequest.getState().clear();
  toastErrorMock.mockClear();
  // The request channel is file-global; a leftover request from a previous
  // test would re-fire here and make the toast count meaningless.
});

afterEach(() => {
  useIllustrationRequest.getState().clear();
  vi.restoreAllMocks();
});

async function seedCampaign(): Promise<Campaign> {
  return createCampaign({ name: 'Emberfall', system: 'dnd5e' });
}

/** A persona list that is LOADED and non-empty but has NO `illustrator` — the
 * "final answer" arm, not the "empty list" degenerate one. */
async function seedNonIllustratorPersona(): Promise<void> {
  await createPersona({
    slug: 'npc-smith-ui',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
}

async function seedIllustrator(): Promise<void> {
  await createPersona({
    slug: 'illustrator',
    name: 'Illustrator',
    description: 'test',
    systemPrompt: 'test',
    mode: 'image',
    builtIn: true,
  });
}

async function seedTarget(campaign: Campaign): Promise<AnyArtifact> {
  return createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Grix',
    summary: '',
    body: '',
  });
}

describe('PersonaPanel illustration hand-off — loaded vs not loaded (docs/17 row 376)', () => {
  it('personas LOADED and no Illustrator: toastError names it and the request is cleared', async () => {
    const campaign = await seedCampaign();
    await seedNonIllustratorPersona();
    const target = await seedTarget(campaign);
    renderPersonaPanel(campaign);
    // Let the live persona query resolve: from here on `personas` is a LOADED,
    // non-empty list and no row in it carries the `illustrator` slug.
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();

    act(() => {
      useIllustrationRequest.getState().request(target.id);
    });
    await flushAsyncUpdates();

    // It SPEAKS — through the ONE house surface — and NAMES what could not be
    // claimed, so the owner knows the "Illustrate…" button did nothing.
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [message] = toastErrorMock.mock.calls[0] ?? [];
    expect(message).toContain('Illustrator');
    // ...and the unclaimed request does NOT sit in the store: a later effect
    // pass cannot re-fire it.
    expect(useIllustrationRequest.getState().artifactId).toBeNull();
    await flushAsyncUpdates();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  }, 30000);

  it('personas NOT loaded yet: NO toast, the request is retained, and it is claimed once they arrive', async () => {
    const campaign = await seedCampaign();
    await seedIllustrator();
    const target = await seedTarget(campaign);
    // The request is in the store BEFORE the panel mounts, so the FIRST effect
    // run is provably the unloaded one (`useLiveQuery`'s first value is
    // `undefined`). This is the non-vacuity arm: without it, the arm above
    // could pass by breaking the normal path.
    act(() => {
      useIllustrationRequest.getState().request(target.id);
    });
    renderPersonaPanel(campaign);

    // Synchronously after mount the personas have not resolved: silence is
    // CORRECT here, and the request must be KEPT.
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useIllustrationRequest.getState().artifactId).toBe(target.id);

    // Once they resolve the SAME request is claimed: the Illustrator is
    // selected, so the illustrate target picker appears, and still no toast.
    expect(await screen.findByRole('combobox', { name: 'Artifact to illustrate' })).toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Persona' })).toHaveTextContent('Illustrator');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Artifact to illustrate' })).toHaveTextContent('Grix'),
    );
    expect(useIllustrationRequest.getState().artifactId).toBeNull();
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);

  it('the happy path is unchanged: Illustrator selected, target set, Assistant tab focused, no toast', async () => {
    const campaign = await seedCampaign();
    await seedIllustrator();
    const target = await seedTarget(campaign);
    const user = userEvent.setup();
    renderPersonaPanel(campaign);
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();

    // Move the tab AWAY first, so "the Assistant tab is focused" is a claim
    // about the effect rather than about the panel's own default tab.
    await user.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(screen.getByRole('tab', { name: 'Assistant' })).toHaveAttribute('aria-selected', 'false');

    act(() => {
      useIllustrationRequest.getState().request(target.id);
    });

    expect(await screen.findByRole('combobox', { name: 'Artifact to illustrate' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Assistant' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('combobox', { name: 'Persona' })).toHaveTextContent('Illustrator');
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Artifact to illustrate' })).toHaveTextContent('Grix'),
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useIllustrationRequest.getState().artifactId).toBeNull();
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);
});
