import 'fake-indexeddb/auto';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComponentProps } from 'react';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import type { Campaign } from '@/domain';
import { ExportCampaignDialog } from '@/features/campaign/components/export-dialog';
import { ImagesSection } from '@/features/campaign/components/images-section';
import { StubPopover } from '@/features/modules/stub-popover';
import { clearDatabase } from '../db/helpers';
import { expectBlockedReason, expectSelfEvidentBlock } from '../helpers/blocked-reason';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * The entity surfaces STATE why their controls cannot act (docs/18 §2.3,
 * docs/05 §Why a control cannot act; docs/17 row 99).
 *
 * Three surfaces, three one-flag blocks that used to be silent:
 *  - the editor's Images section (Upload + Upload battlemap while an upload
 *    intake is running — the label never changes);
 *  - the campaign export dialog (Export while the file is being built and
 *    written) — with the empty-selection half pinned as SELF-EVIDENT, because
 *    the button's own label reads "Export 0 artifact(s)";
 *  - the stub popover (the verdict link, Create stub and Generate while its own
 *    save or in-place generation runs) — with the empty-name and
 *    label-says-"Generating…" halves pinned self-evident.
 *
 * Every assertion goes through the shared pin helpers, so the pinned contract is
 * the device's own (docs/helpers/blocked-reason.ts).
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));
vi.mock('@/lib/imageIntake', () => ({ intakeImage: vi.fn() }));
vi.mock('@/features/modules/entity-detail', () => ({ generateSingleEntity: vi.fn() }));
vi.mock('@/lib/filePicker', () => ({
  openSaveTarget: vi.fn(),
  EXPORT_JSON_TYPES: [{ description: 'Campaign JSON', accept: { 'application/json': ['.json'] } }],
  EXPORT_ZIP_TYPES: [{ description: 'Campaign zip', accept: { 'application/zip': ['.zip'] } }],
}));
vi.mock('@/lib/exportImport', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildCampaignExport: vi.fn(),
}));
vi.mock('@/llm/moduleGen', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  classifyEntityName: vi.fn(),
}));
vi.mock('@/db/artifactAutoPromote', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  promoteArtifactForModuleUseLoud: vi.fn(),
}));

const { intakeImage } = await import('@/lib/imageIntake');
const { generateSingleEntity } = await import('@/features/modules/entity-detail');
const { openSaveTarget } = await import('@/lib/filePicker');
const { buildCampaignExport } = await import('@/lib/exportImport');
const { classifyEntityName } = await import('@/llm/moduleGen');
const { promoteArtifactForModuleUseLoud } = await import('@/db/artifactAutoPromote');

const intakeMock = vi.mocked(intakeImage);
const generateMock = vi.mocked(generateSingleEntity);
const openSaveTargetMock = vi.mocked(openSaveTarget);
const buildExportMock = vi.mocked(buildCampaignExport);
const classifyMock = vi.mocked(classifyEntityName);
const promoteMock = vi.mocked(promoteArtifactForModuleUseLoud);

const UPLOAD_REASON = 'The upload you started is still being saved — wait for it to finish.';
const EXPORT_REASON = 'The export is still being built and written — wait for it to finish.';
const POPOVER_REASON = 'A save from this popover is still running — wait for it to finish.';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let campaign: Campaign;

type ImagesArtifact = ComponentProps<typeof ImagesSection>['artifact'];
type ExportArtifact = ComponentProps<typeof ExportCampaignDialog>['artifacts'][number];

/**
 * The fixture is a plain object cast at each call site to the COMPONENT's own
 * prop type (below): that prop type stays the authority for what the surface
 * reads, so a change in the artifact shape fails this file at the type gate
 * instead of silently rendering less.
 */
function encounterArtifact(): Record<string, unknown> {
  return {
    id: 'artifact-encounter',
    campaignId: campaign.id,
    moduleId: null,
    kind: 'encounter',
    name: 'The Flooded Nave',
    summary: '',
    aliases: [],
    tags: [],
    imageIds: [],
    coverImageId: null,
    createdAt: 0,
    updatedAt: 0,
    data: { mapImageId: null, monsters: [] },
  };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
});

afterEach(cleanup);

describe('the Images section states why its uploads cannot act', () => {
  it('an upload in flight holds BOTH upload controls, each stating why, and the reason lifts with it', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ blob: Blob; mimeType: string; width: number; height: number }>();
    intakeMock.mockReturnValue(pending.promise);
    const { container } = render(<ImagesSection artifact={encounterArtifact() as unknown as ImagesArtifact} />);
    await flushAsyncUpdates();

    // Nothing is held before the upload starts — no reason exists yet.
    expect(screen.getByTestId('upload-image')).toBeEnabled();
    expect(screen.queryByTestId('upload-image-reason')).toBeNull();

    const input = container.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    Object.defineProperty(input, 'files', {
      value: [new File(['bytes'], 'nave.png', { type: 'image/png' })],
    });
    fireEvent.change(input as HTMLInputElement);

    await waitFor(() => {
      expect(screen.getByTestId('upload-image')).toBeDisabled();
    });
    // The OLD upload is what holds the battlemap upload too (`busy` is shared by
    // both handlers) — reported as an over-block finding, reason stated anyway.
    await expectBlockedReason(user, 'upload-image', UPLOAD_REASON);
    await expectBlockedReason(user, 'upload-battlemap', UPLOAD_REASON);

    pending.resolve({
      blob: new Blob(['bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
    });
    await waitFor(() => {
      expect(screen.queryByTestId('upload-image-reason')).toBeNull();
    });
    await flushAsyncUpdates();
  }, 30_000);
});

describe('the export dialog states why Export cannot act', () => {
  it('a build in flight states the reason; an EMPTY selection states none (the label already says "Export 0 artifact(s)")', async () => {
    const user = userEvent.setup();
    const pending = deferred<never>();
    buildExportMock.mockReturnValue(pending.promise);
    openSaveTargetMock.mockResolvedValue({
      cancelled: false,
      write: vi.fn(() => Promise.resolve(undefined)),
    });

    const artifact = encounterArtifact() as unknown as ExportArtifact;
    render(
      <ExportCampaignDialog
        campaignId={campaign.id}
        campaignName="Emberfall"
        artifacts={[artifact]}
        open
        onOpenChange={vi.fn()}
      />,
    );
    await screen.findByTestId('export-run');
    expect(screen.getByTestId('export-run')).toBeEnabled();

    await user.click(screen.getByTestId('export-run'));
    await waitFor(() => {
      expect(screen.getByTestId('export-run')).toBeDisabled();
    });
    await expectBlockedReason(user, 'export-run', EXPORT_REASON);

    // Let the (deferred) build land so the busy flag falls with it.
    pending.resolve(undefined as never);
    await waitFor(() => {
      expect(screen.queryByTestId('export-run-reason')).toBeNull();
    });

    // The other rung: deselect everything — disabled, and deliberately bare.
    await user.click(screen.getByRole('checkbox', { name: 'All artifacts (1)' }));
    await waitFor(() => {
      expect(screen.getByTestId('export-run')).toBeDisabled();
    });
    expect(screen.getByTestId('export-run')).toHaveTextContent('Export 0 artifact(s)');
    expectSelfEvidentBlock('export-run');
    await flushAsyncUpdates();
  }, 30_000);
});

describe('the stub popover states why its actions cannot act', () => {
  async function renderPopover(): Promise<void> {
    await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Warden Bellamy',
      summary: 'The tower keeper.',
    });
    classifyMock.mockResolvedValue({ kind: 'npc', canonical: 'Warden Bellamy' });
    render(
      <StubPopover
        state={{ name: 'Bellamy the Elder', x: 0, y: 0 }}
        sentence="The elder watched the tide."
        contextParagraphs=""
        premise="A drowned vault."
        moduleTag="module:The Drowned Vault"
        moduleId="module-1"
        campaign={campaign}
        onClose={vi.fn()}
        onLinkExisting={vi.fn()}
      />,
    );
    await screen.findByTestId('stub-link-verdict', {}, { timeout: 5_000 });
    await flushAsyncUpdates();
  }

  it('a link in flight holds the link and both create controls, each stating why', async () => {
    const user = userEvent.setup();
    const pending = deferred<never>();
    promoteMock.mockReturnValue(pending.promise);
    await renderPopover();

    await user.click(screen.getByTestId('stub-link-verdict'));
    await waitFor(() => {
      expect(screen.getByTestId('stub-link-verdict')).toBeDisabled();
    });
    await expectBlockedReason(user, 'stub-link-verdict', POPOVER_REASON);
    await expectBlockedReason(user, 'stub-create', POPOVER_REASON);
    await expectBlockedReason(user, 'stub-generate', POPOVER_REASON);

    pending.resolve(undefined as never);
    await waitFor(() => {
      expect(screen.queryByTestId('stub-create-reason')).toBeNull();
    });
    await flushAsyncUpdates();
  }, 30_000);

  it('SELF-EVIDENT: an in-place generation says "Generating…" on the control itself, so it carries no reason', async () => {
    const user = userEvent.setup();
    const pending = deferred<never>();
    generateMock.mockReturnValue(pending.promise);
    await renderPopover();

    // The verdict resolves the name onto an existing entity, so the first press
    // only ARMS the override (the popover's two-step confirm).
    await user.click(screen.getByTestId('stub-generate'));
    await waitFor(() => {
      expect(screen.getByTestId('stub-generate')).toHaveTextContent('confirm?');
    });
    await user.click(screen.getByTestId('stub-generate'));
    await waitFor(() => {
      expect(screen.getByTestId('stub-generate')).toHaveTextContent('Generating…');
    });
    expectSelfEvidentBlock('stub-generate');

    pending.resolve(undefined as never);
    await flushAsyncUpdates();
  }, 30_000);

  it('SELF-EVIDENT: an empty name is nothing to create — the gate is bare', async () => {
    await renderPopover();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    await waitFor(() => {
      expect(screen.getByTestId('stub-create')).toBeDisabled();
    });
    expectSelfEvidentBlock('stub-create');
    await flushAsyncUpdates();
  }, 30_000);
});
