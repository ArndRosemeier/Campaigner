import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  type ModuleEntityKind,
} from '@/domain';
import { clearDatabase } from '../db/helpers';
import { flushAsyncUpdates } from '../helpers/flush';

/**
 * Module reader (08-MODULE-DESIGNER M4-A): document rendering (title, badges,
 * premise chips, part sections, failed-part card), the mini-ToC scroll, the
 * per-part hand edit (save on blur → `edited: true`), the rewrite confirmation
 * dialog for hand-edited parts, and the stub popover behind an unresolved chip
 * (create artifact with the `module:<title>` tag → chip resolves).
 */

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

// The popover's "Generate" runs a real chain → real runEngine; only the LLM
// entry point is mocked (embeddings stays inert: no rulebooks are seeded).
vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
  fetchWithHeadersTimeout: vi.fn(),
}));

// Only the LLM entry points are mocked; `moduleGenEvents` (the in-memory
// streaming emitter the reader subscribes to) stays real via the spread.
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
    // The stub popover classifies hand-typed names via a chat call — mocked
    // here (the seeded module's kinds are asserted explicitly).
    classifyEntityName: vi.fn(),
  };
});

const { rewritePart, classifyEntityName } = await import('@/llm/moduleGen');
const rewriteMock = vi.mocked(rewritePart);
const classifyEntityNameMock = vi.mocked(classifyEntityName);
const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastSuccess } = await import('@/lib/toast');
const toastSuccessMock = vi.mocked(toastSuccess);

const MODULE_TITLE = 'The Drowned Vault';

const PREMISE =
  'The party is hired to recover a drowned relic from the [[Old Tower]], where the [[Missing Person]] was last seen.';

function renderAppAt(path: string): void {
  window.history.replaceState(null, '', path);
  render(<RouterProvider router={createAppRouter()} />);
}

async function seedReaderModule(
  options: { part0Edited?: boolean; entityKinds?: ModuleEntityKind[] } = {},
): Promise<{
  campaign: Campaign;
  campaignId: Id;
  moduleId: Id;
}> {
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
    title: MODULE_TITLE,
    concept: 'A flooded vault beneath a watchtower.',
    levelMin: 1,
    levelMax: 3,
    tone: '',
    sizeDial: 'standard',
  });
  const spine = moduleSpineSchema.parse({
    premise: PREMISE,
    themes: ['bargains', 'rising water'],
    partPlan: [
      {
        title: 'The Gate Bargain',
        levelBand: '1',
        synopsis: 'The party negotiates entry with the tower keeper.',
        levelUpTrigger: 'The gate opens.',
      },
      {
        title: 'Into the Vault',
        levelBand: '2–3',
        synopsis: 'The vault floods as the relic is recovered.',
        levelUpTrigger: 'The relic is recovered.',
      },
    ],
  });
  const saved = await saveModule({
    ...draft,
    status: 'ready',
    spine,
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown:
          'The party climbs to the [[Old Tower]] before dawn. A lantern still burns in the top room.',
        status: 'ready',
        errorMessage: '',
        edited: options.part0Edited ?? false,
      }),
      modulePartSchema.parse({
        planIndex: 1,
        markdown: '',
        status: 'failed',
        errorMessage: 'boom',
        edited: false,
      }),
    ],
    ...(options.entityKinds === undefined ? {} : { entityKinds: options.entityKinds }),
  });
  return { campaign, campaignId: campaign.id, moduleId: saved.id };
}

/** Waits for the reader to mount and returns the `#part-0` section. */
async function findPartSection(partIndex: number): Promise<HTMLElement> {
  await screen.findByTestId('module-reader', {}, { timeout: 10_000 });
  return waitFor(() => {
    const section = document.getElementById(`part-${String(partIndex)}`);
    if (section === null) throw new Error(`part-${String(partIndex)} not mounted yet`);
    return section;
  });
}

beforeEach(clearDatabase);

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ModuleReaderPage', () => {
  it('renders title, level badges, premise wiki chips, part sections and the failed-part card', async () => {
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    expect(
      await screen.findByLabelText('Module title', {}, { timeout: 10_000 }),
    ).toHaveValue(MODULE_TITLE);
    expect(screen.getByText('Levels 1–3')).toBeInTheDocument();
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();

    // Premise: [[Old Tower]] resolves against the seeded artifact, [[Missing
    // Person]] has no artifact yet and stays an unresolved stub chip.
    const intro = document.getElementById('module-intro');
    if (intro === null) throw new Error('module-intro section missing');
    const premiseChips = within(intro).getAllByTestId('wiki-chip');
    expect(
      premiseChips.some((chip) => chip.getAttribute('data-wiki-name') === 'Old Tower'),
    ).toBe(true);
    expect(within(intro).getByTestId('wiki-chip-unresolved')).toHaveAttribute(
      'data-wiki-name',
      'Missing Person',
    );

    // Part sections carry the plan titles as H1s; part 0 shows its markdown.
    const part0 = document.getElementById('part-0');
    const part1 = document.getElementById('part-1');
    if (part0 === null || part1 === null) throw new Error('part sections missing');
    expect(within(part0).getByRole('heading', { name: 'The Gate Bargain' })).toBeInTheDocument();
    expect(within(part0).getByText('Levels 1')).toBeInTheDocument();
    expect(within(part0).getByTestId('part-body')).toHaveTextContent('lantern still burns');
    expect(within(part1).getByRole('heading', { name: 'Into the Vault' })).toBeInTheDocument();
    expect(within(part1).getByText('Levels 2–3')).toBeInTheDocument();

    // The failed part is a loud card with the persisted error and a Retry.
    const failed = screen.getByTestId('part-failed');
    expect(failed).toHaveTextContent('boom');
    expect(within(failed).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);

  it('lists the plan titles in the ToC and scrolls to a part on click', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));
    await findPartSection(0);

    const toc = screen.getByTestId('module-toc');
    expect(within(toc).getByText('Intro')).toBeInTheDocument();
    expect(within(toc).getByText('1 · The Gate Bargain')).toBeInTheDocument();
    expect(within(toc).getByText('2–3 · Into the Vault')).toBeInTheDocument();

    // tests/setup.ts stubs Element.scrollIntoView (jsdom lacks it) — spy on
    // the stub to assert the reader actually scrolls to the section.
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
    await user.click(within(toc).getByRole('button', { name: '2–3 · Into the Vault' }));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth' });
    scrollSpy.mockRestore();
    await flushAsyncUpdates();
  }, 20_000);

  it('saves a part hand edit on blur, persisting the new markdown with edited: true', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    const part0 = await findPartSection(0);
    await user.click(within(part0).getByTestId('part-edit'));

    // The textarea opens prefilled with the part's markdown (save on blur).
    const textarea = await within(part0).findByRole('textbox', {}, { timeout: 5_000 });
    const edited =
      'The party climbs to the [[Old Tower]] at midnight. The vault door hums below the floor.';
    fireEvent.change(textarea, { target: { value: edited } });
    fireEvent.blur(textarea);

    // The edit lands on the module row, flagged as hand-edited.
    await waitFor(
      async () => {
        const row = await getModule(moduleId);
        const part = row?.parts.find((entry) => entry.planIndex === 0);
        expect(part?.markdown).toBe(edited);
        expect(part?.edited).toBe(true);
        expect(part?.status).toBe('ready');
      },
      { timeout: 10_000 },
    );
    expect(toastSuccessMock).toHaveBeenCalledWith('Part saved');

    // The reader leaves edit mode and renders the saved text again.
    expect(await screen.findByTestId('part-body', {}, { timeout: 5_000 })).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);

  it('confirms a rewrite of the hand-edited part: warning, inert Cancel, confirm calls rewritePart', async () => {
    const user = userEvent.setup();
    // The part is marked edited first (the persisting edit path itself is
    // covered by the test above).
    const { campaign, campaignId, moduleId } = await seedReaderModule({ part0Edited: true });
    renderAppAt(modulePath(campaignId, moduleId));
    await findPartSection(0);

    await user.click(screen.getByTestId('part-rewrite'));
    const dialog = await screen.findByTestId('rewrite-dialog', {}, { timeout: 5_000 });
    // Hand-edited warning is shown before the destructive rewrite.
    expect(within(dialog).getByRole('alert')).toHaveTextContent('hand-edited');

    // Cancel closes without touching the generator.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByTestId('rewrite-dialog')).not.toBeInTheDocument();
    });
    expect(rewriteMock).not.toHaveBeenCalled();

    // Confirming calls the generator for exactly this part (planIndex 0).
    await user.click(screen.getByTestId('part-rewrite'));
    const dialog2 = await screen.findByTestId('rewrite-dialog', {}, { timeout: 5_000 });
    await user.click(within(dialog2).getByRole('button', { name: 'Rewrite part' }));
    expect(rewriteMock).toHaveBeenCalledTimes(1);
    expect(rewriteMock).toHaveBeenCalledWith(moduleId, campaign, 0, '');
    await flushAsyncUpdates();
  }, 20_000);

  it('creates a stub from an unresolved chip and the chip resolves once the artifact exists', async () => {
    const user = userEvent.setup();
    const { campaign, campaignId, moduleId } = await seedReaderModule();
    // No recorded kind for this name → the popover classifies it (mocked).
    classifyEntityNameMock.mockResolvedValue({ kind: 'npc', canonical: 'Missing Person' });
    renderAppAt(modulePath(campaignId, moduleId));

    const chip = await screen.findByTestId('wiki-chip-unresolved', {}, { timeout: 10_000 });
    expect(chip).toHaveAttribute('data-wiki-name', 'Missing Person');
    await user.click(chip);

    // The popover opens with the link name prefilled.
    const popover = await screen.findByTestId('stub-popover', {}, { timeout: 5_000 });
    expect(within(popover).getByLabelText('Name')).toHaveValue('Missing Person');
    // The one-shot classification call drives the kind preselect (08 §M4-C);
    // Base UI's Select.Value renders the raw value string.
    await waitFor(() => {
      expect(within(popover).getByText('npc')).toBeInTheDocument();
    });

    await user.click(within(popover).getByTestId('stub-create'));

    // The stub artifact exists with the model-classified kind, the module tag
    // and the first-occurrence sentence as summary.
    await waitFor(
      async () => {
        const rows = await listArtifactsByCampaign(campaignId);
        const stub = rows.find((row) => row.name === 'Missing Person');
        expect(stub?.campaignId).toBe(campaign.id);
        expect(stub?.kind).toBe('npc');
        expect(stub?.tags).toEqual([`module:${MODULE_TITLE}`]);
        expect(stub?.summary).toContain('Missing Person was last seen');
      },
      { timeout: 10_000 },
    );

    // The popover closes and the chip now renders resolved.
    await waitFor(
      () => {
        expect(screen.queryByTestId('stub-popover')).not.toBeInTheDocument();
        expect(screen.queryByTestId('wiki-chip-unresolved')).not.toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
    const resolvedChips = screen.getAllByTestId('wiki-chip');
    expect(
      resolvedChips.some((resolved) => resolved.getAttribute('data-wiki-name') === 'Missing Person'),
    ).toBe(true);
    await flushAsyncUpdates();
  }, 20_000);

  it('defaults to alias-linking when the verdict resolves the name onto an existing artifact (fix-01)', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    // The canonical entity the model will name already exists in the campaign.
    const canonical = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Warden Bellamy',
      summary: 'The tower keeper.',
    });
    classifyEntityNameMock.mockResolvedValue({ kind: 'npc', canonical: 'Warden Bellamy' });
    renderAppAt(modulePath(campaignId, moduleId));

    const chip = await screen.findByTestId('wiki-chip-unresolved', {}, { timeout: 10_000 });
    await user.click(chip);
    const popover = await screen.findByTestId('stub-popover', {}, { timeout: 5_000 });

    // The verdict is shown as the reason, and linking is the primary action.
    expect(within(popover).getByTestId('stub-verdict')).toHaveTextContent('Warden Bellamy');
    await user.click(within(popover).getByTestId('stub-link-verdict'));

    // No second artifact: the link name became an alias on the canonical one.
    await waitFor(
      async () => {
        const rows = await listArtifactsByCampaign(campaignId);
        const warden = rows.find((row) => row.id === canonical.id);
        expect(warden?.aliases).toContain('Missing Person');
        expect(rows.filter((row) => row.name === 'Missing Person')).toHaveLength(0);
      },
      { timeout: 10_000 },
    );
    // The chip now resolves through the alias.
    await waitFor(
      () => {
        expect(screen.queryByTestId('stub-popover')).not.toBeInTheDocument();
        expect(screen.queryByTestId('wiki-chip-unresolved')).not.toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('requires the inline two-step confirm to override the verdict with a standalone stub (fix-01)', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    await createArtifact({ campaignId, kind: 'npc', name: 'Warden Bellamy', summary: 'The tower keeper.' });
    classifyEntityNameMock.mockResolvedValue({ kind: 'npc', canonical: 'Warden Bellamy' });
    renderAppAt(modulePath(campaignId, moduleId));

    const chip = await screen.findByTestId('wiki-chip-unresolved', {}, { timeout: 10_000 });
    await user.click(chip);
    const popover = await screen.findByTestId('stub-popover', {}, { timeout: 5_000 });

    // First click ARMS the override — nothing is created yet.
    await user.click(within(popover).getByTestId('stub-create'));
    expect(within(popover).getByTestId('stub-create')).toHaveTextContent(
      'Create as a separate entity — confirm?',
    );
    expect(
      (await listArtifactsByCampaign(campaignId)).filter((row) => row.name === 'Missing Person'),
    ).toHaveLength(0);

    // Second click is the deliberate act.
    await user.click(within(popover).getByTestId('stub-create'));
    await waitFor(
      async () => {
        const rows = await listArtifactsByCampaign(campaignId);
        const stub = rows.find((row) => row.name === 'Missing Person');
        expect(stub?.kind).toBe('npc');
      },
      { timeout: 10_000 },
    );
  }, 20_000);

  it('preselects the kind the generator recorded without a classification call', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule({
      entityKinds: [{ name: 'Missing Person', kind: 'faction', absorbed: [] }],
    });
    renderAppAt(modulePath(campaignId, moduleId));

    const chip = await screen.findByTestId('wiki-chip-unresolved', {}, { timeout: 10_000 });
    await user.click(chip);

    const popover = await screen.findByTestId('stub-popover', {}, { timeout: 5_000 });
    // The recorded kind is shown immediately…
    expect(within(popover).getByText('faction')).toBeInTheDocument();
    // …and the popover never asks the model again for a recorded name.
    expect(classifyEntityNameMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 20_000);

  it('generates an entity IN PLACE from the popover — no navigation, chip resolves', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule({
      entityKinds: [{ name: 'Missing Person', kind: 'note', absorbed: [] }],
    });
    chatMock.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Missing Person',
        summary: 'Seen near the tower.',
        suggestedTags: [],
        body: '# Missing Person\nThey never came down.',
      }),
    );
    renderAppAt(modulePath(campaignId, moduleId));

    const chip = await screen.findByTestId('wiki-chip-unresolved', {}, { timeout: 10_000 });
    await user.click(chip);
    const popover = await screen.findByTestId('stub-popover', {}, { timeout: 5_000 });
    await user.click(within(popover).getByTestId('stub-generate'));

    // The chain → runEngine → database path produces the artifact with the
    // module tag (same machinery as the batch).
    await waitFor(
      async () => {
        const rows = await listArtifactsByCampaign(campaignId);
        const produced = rows.find((row) => row.name === 'Missing Person');
        expect(produced?.kind).toBe('note');
        expect(produced?.tags).toContain(`module:${MODULE_TITLE}`);
      },
      { timeout: 10_000 },
    );

    // The chip resolves WITHOUT leaving the reader: the old behavior navigated
    // to the workspace, which looked like the app closing the view.
    await waitFor(
      () => {
        expect(screen.queryByTestId('stub-popover')).not.toBeInTheDocument();
        expect(screen.queryByTestId('wiki-chip-unresolved')).not.toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
    const resolvedChips = screen.getAllByTestId('wiki-chip');
    expect(
      resolvedChips.some(
        (resolved) => resolved.getAttribute('data-wiki-name') === 'Missing Person',
      ),
    ).toBe(true);
    // The module reader is still the mounted page (title input + toast).
    expect(screen.getByTestId('module-title')).toHaveValue(MODULE_TITLE);
    expect(toastSuccessMock).toHaveBeenCalledWith('"Missing Person" detailed');
    await flushAsyncUpdates();
  }, 20_000);

  it('opens the entity card (peek modal) from a resolved panel row', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    // 'Old Tower' ships resolved in the seed; its panel row must open the
    // entity card — NOT scroll the module text (module-mode-as-play, first
    // step: entity click = card).
    const rows = await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
    const towerRow = rows.find((row) => row.textContent.includes('Old Tower'));
    if (towerRow === undefined) throw new Error('Old Tower row not found in the entity panel');
    await user.click(towerRow);

    const peek = await screen.findByTestId('peek-modal', {}, { timeout: 5_000 });
    expect(within(peek).getByText('Old Tower')).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);

  it('shows the entity image in the card with a fullscreen view (and no play focus)', async () => {
    const user = userEvent.setup();
    // jsdom lacks object URL support; the hooks revoke what they create.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => `blob:mock-${Math.random()}`),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    const { campaignId, moduleId } = await seedReaderModule();
    const artifacts = await listArtifactsByCampaign(campaignId);
    const tower = artifacts.find((artifact) => artifact.name === 'Old Tower');
    if (tower === undefined) throw new Error('Old Tower artifact missing from the seed');
    const stored = await createImage({
      campaignId,
      blob: new Blob(['tower-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 8,
      height: 8,
      source: 'uploaded',
    });
    await updateArtifact(tower.id, { imageIds: [stored.id], coverImageId: stored.id });

    renderAppAt(modulePath(campaignId, moduleId));
    const rows = await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
    const towerRow = rows.find((row) => row.textContent.includes('Old Tower'));
    if (towerRow === undefined) throw new Error('Old Tower row not found in the entity panel');
    await user.click(towerRow);

    const peek = await screen.findByTestId('peek-modal', {}, { timeout: 5_000 });
    // Play-mode retirement: the "Focus in Play" button is gone.
    expect(screen.queryByRole('button', { name: 'Focus in Play' })).not.toBeInTheDocument();
    // The image banner shows the entity's cover image; clicking it opens the
    // fullscreen lightbox.
    const banner = await within(peek).findByTestId('peek-image', {}, { timeout: 5_000 });
    await user.click(banner);
    expect(
      await screen.findByTestId('peek-image-fullscreen', {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    await flushAsyncUpdates();
  }, 20_000);

  it('moves an entity into the Focused group and back via the star toggle', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    expect(screen.queryByTestId('focused-group')).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole('button', { name: 'Focus Old Tower' }, { timeout: 10_000 }),
    );

    // The patch flows back through the module live query and regroups live.
    const focused = await screen.findByTestId('focused-group', {}, { timeout: 10_000 });
    expect(within(focused).getByTestId('entity-row')).toHaveTextContent('Old Tower');

    await user.click(within(focused).getByRole('button', { name: 'Unfocus Old Tower' }));
    await waitFor(
      () => {
        expect(screen.queryByTestId('focused-group')).not.toBeInTheDocument();
      },
      { timeout: 10_000 },
    );
    await flushAsyncUpdates();
  }, 20_000);

  it('searches the rendered module text and jumps between matches', async () => {
    // jsdom does not implement scrollIntoView; the search uses it to bring the
    // active match into view.
    Element.prototype.scrollIntoView = vi.fn();
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    const input = await screen.findByTestId('reader-search-input', {}, { timeout: 10_000 });
    await user.type(input, 'lantern');

    // Exactly one occurrence: part 0's "A lantern still burns…".
    await waitFor(() => {
      expect(screen.getByTestId('reader-search-count')).toHaveTextContent('1 / 1');
    });
    await user.click(screen.getByTestId('reader-search-next'));
    expect(document.querySelector('.search-hit')).not.toBeNull();

    // Cycling wraps around on a single match; clearing resets everything.
    await user.click(screen.getByTestId('reader-search-next'));
    expect(screen.getByTestId('reader-search-count')).toHaveTextContent('1 / 1');
    await user.click(screen.getByTestId('reader-search-clear'));
    expect(screen.getByTestId('reader-search-count')).toHaveTextContent('–');
    expect(document.querySelector('.search-hit')).toBeNull();
    await flushAsyncUpdates();
  }, 20_000);
});
