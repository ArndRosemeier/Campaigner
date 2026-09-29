import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { ROUTES } from '@/app/routes';
import { CampaignPickerPage } from '@/features/campaign/CampaignPickerPage';
import { CampaignDocumentPage } from '@/features/modules/CampaignDocumentPage';
import { StubCreateDialog } from '@/features/modules/stub-create-dialog';
import { createCampaign, listCampaigns } from '@/db/campaignRepo';
import { listModulesByCampaign } from '@/db/moduleRepo';
import { db } from '@/db/db';
import { clearDatabase } from '../db/helpers';
import { actDrained, flushAsyncUpdates } from '../helpers/flush';
import { countsIn, rawSourceText } from '../helpers/sourceCode';

/**
 * THE CAMPAIGN ENTRY IS THE CHAT (docs/17 row 395, owner-directed): New campaign
 * is ONE action with no form, landing straight in the canvas chat over an EMPTY
 * document; a campaign that has no document lands there too; a click on a
 * not-yet-generated artifact ASKS first. Nothing generates without a click.
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));
vi.mock('@/features/modules/entity-detail', () => ({ generateSingleEntity: vi.fn() }));
vi.mock('@/llm/moduleGen', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  classifyEntityName: vi.fn(),
}));

const { generateSingleEntity } = await import('@/features/modules/entity-detail');
const { classifyEntityName } = await import('@/llm/moduleGen');
const generateMock = vi.mocked(generateSingleEntity);
const classifyMock = vi.mocked(classifyEntityName);

const CHAT_ROUTE = /^\/c\/[^/]+\/m\/[^/]+\/canvas$/;

function Where(): React.JSX.Element {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  cleanup();
  fetchSpy.mockRestore();
});

describe('New campaign lands in the chat', () => {
  it('one click: campaign + EMPTY document, on the chat route, no dialog, no model call', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
        <Routes>
          <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(await screen.findByTestId('new-campaign'));
    const where = await screen.findByTestId('where');
    const [path, search] = where.textContent.split('?');
    expect(path).toMatch(CHAT_ROUTE);
    expect(search).toBe('chat=open');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    const campaigns = await actDrained(() => listCampaigns());
    expect(campaigns).toHaveLength(1);
    const first = campaigns[0];
    expect(first?.name).toBe('New campaign');
    const modules = await actDrained(() => listModulesByCampaign(first?.id ?? ''));
    expect(modules).toHaveLength(1);
    expect(path).toBe(`/c/${first?.id}/m/${modules[0]?.id}/canvas`);
    // EMPTY document: no level section, no premise text.
    const row = await actDrained(() => db.modules.get(modules[0]?.id ?? ''));
    expect(row?.document.trim()).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20_000);

  function mountPicker(): ReturnType<typeof userEvent.setup> {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={[ROUTES.campaignPicker]}>
        <Routes>
          <Route path={ROUTES.campaignPicker} element={<CampaignPickerPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    return user;
  }

  it('a typed name becomes the campaign name (Enter submits like the button)', async () => {
    const user = mountPicker();
    await user.type(await screen.findByTestId('new-campaign-name'), '  Ashen Crown {Enter}');
    const where = await screen.findByTestId('where');
    expect(where.textContent).toMatch(/^\/c\/[^/]+\/m\/[^/]+\/canvas\?chat=open$/);
    expect(screen.queryByRole('dialog')).toBeNull();
    const campaigns = await actDrained(() => listCampaigns());
    expect(campaigns.map((c) => c.name)).toEqual(['Ashen Crown']);
    const { listModulesByCampaign } = await import('@/db/moduleRepo');
    // Row 402: the document is titled with the typed campaign name.
    expect((await actDrained(() => listModulesByCampaign(campaigns[0]?.id ?? '')))[0]?.title).toBe('Ashen Crown');
    expect(fetchSpy).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20_000);

  it('a whitespace-only field creates "New campaign"', async () => {
    const user = mountPicker();
    await user.type(await screen.findByTestId('new-campaign-name'), '   ');
    await user.click(screen.getByTestId('new-campaign'));
    await screen.findByTestId('where');
    const campaigns = await actDrained(() => listCampaigns());
    expect(campaigns.map((c) => c.name)).toEqual(['New campaign']);
    const { listModulesByCampaign } = await import('@/db/moduleRepo');
    expect((await actDrained(() => listModulesByCampaign(campaigns[0]?.id ?? '')))[0]?.title).toBe('New campaign');
    await flushAsyncUpdates();
  }, 20_000);

  it('the name stays editable through the existing repo/edit path', async () => {
    const user = mountPicker();
    await user.type(await screen.findByTestId('new-campaign-name'), 'First{Enter}');
    await screen.findByTestId('where');
    const [created] = await actDrained(() => listCampaigns());
    const { updateCampaign } = await import('@/db/campaignRepo');
    await actDrained(() => updateCampaign(created?.id ?? '', { name: 'Second' }));
    expect((await actDrained(() => listCampaigns()))[0]?.name).toBe('Second');
    await flushAsyncUpdates();
  }, 20_000);

  it('an EXISTING campaign with no document lands in the chat, not a form', async () => {
    const campaign = await createCampaign({ name: 'Old', system: 'dnd5e' });
    render(
      <MemoryRouter initialEntries={[`/c/${campaign.id}/document`]}>
        <Routes>
          <Route path="/c/:campaignId/document" element={<CampaignDocumentPage />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    const where = await screen.findByTestId('where', {}, { timeout: 10_000 });
    expect(where.textContent).toMatch(/^\/c\/[^/]+\/m\/[^/]+\/canvas\?chat=open$/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('new-module')).toBeNull();
    const modules = await actDrained(() => listModulesByCampaign(campaign.id));
    expect(modules).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20_000);
});

describe('a not-yet-generated artifact asks first', () => {
  const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
  const MODULE_ID = '22222222-2222-4222-8222-222222222222';

  async function mountDialog(onClose = vi.fn()): Promise<{ onClose: ReturnType<typeof vi.fn> }> {
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    render(
      <StubCreateDialog
        name="Old Tom"
        campaign={{ ...campaign, id: campaign.id }}
        moduleId={MODULE_ID}
        contextParagraphs=""
        premise=""
        recordedKind="npc"
        onClose={onClose}
        onMoreOptions={vi.fn()}
      />,
    );
    await screen.findByTestId('stub-create-dialog');
    return { onClose };
  }

  it('opens “Create <name>?” and generates NOTHING until confirmed', async () => {
    await mountDialog();
    expect(screen.getByText('Create “Old Tom”?')).toBeInTheDocument();
    await flushAsyncUpdates();
    expect(generateMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
  }, 20_000);

  it('confirm generates through the existing single-entity path', async () => {
    generateMock.mockResolvedValue({ ok: true, artifactId: CAMPAIGN_ID });
    const user = userEvent.setup();
    const { onClose } = await mountDialog();
    await user.click(screen.getByTestId('stub-create-confirm'));
    await waitFor(() => {
      expect(generateMock).toHaveBeenCalledTimes(1);
    });
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Old Tom', kind: 'npc', moduleId: MODULE_ID }),
    );
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    await flushAsyncUpdates();
  }, 20_000);

  it('decline does nothing at all', async () => {
    const user = userEvent.setup();
    const { onClose } = await mountDialog();
    await user.click(screen.getByTestId('stub-create-decline'));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
    expect(generateMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20_000);
});

describe('the deleted creation dialog stays deleted', () => {
  it('its identifiers appear in NO file but this pin (non-vacuous: this file carries them)', async () => {
    const raw = await rawSourceText();
    const here = 'tests/features/campaign-entry.test.tsx';
    for (const needle of [
      'NewModuleDialog',
      'new-module-dialog',
      'NewModuleDraft',
      'newModuleDraft',
      'CreateCampaignDialog',
      'readStoredNewModuleDraft',
    ]) {
      const carriers = [...countsIn(raw, 'src/', needle), ...countsIn(raw, 'tests/', needle)];
      expect(carriers.map(([path]) => path)).toEqual([here]);
    }
  });
});
