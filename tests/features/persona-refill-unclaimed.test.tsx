import 'fake-indexeddb/auto';

import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import type { AnyArtifact, Campaign } from '@/domain';
import { useContentRefillRequest } from '@/features/campaign/contentRefillRequest';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';
import { renderPersonaPanel } from '../helpers/personaPanel';

/**
 * THE REFILL REQUEST IS NEVER SILENTLY DROPPED (docs/17 row 374). The panel's
 * refill effect used to carry ONE `return` for two different worlds — the
 * persona list has not loaded yet (wait; KEEP the request) and the list HAS
 * loaded and nothing claims the kind (a FINAL answer that must SPEAK and CLEAR
 * the request). The three arms below are the two worlds and the unchanged happy
 * path, driven through the REAL panel so the pin proves the effect is mounted
 * (not merely that the pure rule returns undefined).
 *
 * The house error surface is `lib/toast.toastError` (AGENTS rule 2) — the same
 * one the panel already uses — so it is mocked here and asserted by call, NOT
 * re-implemented.
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
  useContentRefillRequest.getState().clear();
  toastErrorMock.mockClear();
  // The request channel is file-global; a leftover request from a previous
  // test would re-fire here and make the toast count meaningless.
});

afterEach(() => {
  useContentRefillRequest.getState().clear();
  vi.restoreAllMocks();
});

/** A campaign with ONE generate persona producing `npc` (its slug is NOT the
 * canonical `npc-smith`, so `resolveRefillPersona`'s producesKind fallback is
 * what claims an `npc` request — the same fixture shape the existing refill
 * pins use). No built-in personas are seeded here: tests render the panel
 * directly, so `listPersonas` sees exactly what this helper writes. */
async function seedSmithCampaign(): Promise<Campaign> {
  const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
  await createPersona({
    slug: 'npc-smith-ui',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return campaign;
}

async function seedArtifact(campaign: Campaign, kind: 'npc' | 'pc'): Promise<AnyArtifact> {
  return createArtifact({
    campaignId: campaign.id,
    kind,
    name: kind === 'pc' ? 'Kestrel' : 'Grix',
    summary: '',
    body: '',
  });
}

describe('PersonaPanel refill request — loaded vs not loaded (docs/17 row 374)', () => {
  it('personas LOADED and nothing claims the kind: toastError names the kind and the request is cleared', async () => {
    const campaign = await seedSmithCampaign();
    const target = await seedArtifact(campaign, 'pc');
    renderPersonaPanel(campaign);
    // Let the live persona query resolve: from here on `personas` is a list,
    // and no persona in it produces `pc` (there is no `pc-smith` here).
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();

    act(() => {
      useContentRefillRequest.getState().request(target.id, 'pc', false);
    });
    await flushAsyncUpdates();

    // It SPEAKS — through the ONE house surface — and NAMES the kind, so the
    // owner knows which artifact's button did nothing.
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [message] = toastErrorMock.mock.calls[0] ?? [];
    expect(message).toContain('PC');
    // ...and the unclaimed request does NOT sit in the store: a second effect
    // pass (or a later kind) cannot re-fire it.
    expect(useContentRefillRequest.getState().artifactId).toBeNull();
    expect(useContentRefillRequest.getState().kind).toBeNull();
    await flushAsyncUpdates();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  }, 30000);

  it('personas NOT loaded yet: NO toast, the request is retained, and it is claimed once they arrive', async () => {
    const campaign = await seedSmithCampaign();
    const target = await seedArtifact(campaign, 'npc');
    // The request is in the store BEFORE the panel mounts, so the FIRST effect
    // run is provably the unloaded one (`useLiveQuery`'s first value is
    // `undefined`). This is the non-vacuity arm: without it, the arm above
    // could pass by breaking the normal path.
    act(() => {
      useContentRefillRequest.getState().request(target.id, 'npc', false);
    });
    renderPersonaPanel(campaign);

    // Synchronously after mount the personas have not resolved: silence is
    // CORRECT here, and the request must be KEPT.
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useContentRefillRequest.getState().artifactId).toBe(target.id);

    // Once they resolve the SAME request is claimed: the smith is selected,
    // the target notice appears, and still no toast.
    expect(await screen.findByTestId('refill-target-notice')).toBeInTheDocument();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Persona' })).toHaveTextContent('NPC Smith');
    expect(screen.getByRole('combobox', { name: 'Artifact to refill' })).toBeInTheDocument();
    expect(useContentRefillRequest.getState().artifactId).toBeNull();
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);

  it('a kind that HAS a persona is unchanged: selected, targeted, box cleared, no toast', async () => {
    const campaign = await seedSmithCampaign();
    const target = await seedArtifact(campaign, 'npc');
    renderPersonaPanel(campaign);
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();

    act(() => {
      useContentRefillRequest.getState().request(target.id, 'npc', false);
    });

    expect(await screen.findByTestId('refill-target-notice')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Persona' })).toHaveTextContent('NPC Smith');
    expect(screen.getByRole('combobox', { name: 'Artifact to refill' })).toBeInTheDocument();
    // The box starts EMPTY and carries only the OWNER'S words (docs/17 row 287).
    expect(
      screen.getByPlaceholderText(
        'Instruction for this artifact, e.g. rebuild the stat block at level 5',
      ),
    ).toHaveValue('');
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(useContentRefillRequest.getState().artifactId).toBeNull();
    await flushAsyncUpdates();
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30000);
});
