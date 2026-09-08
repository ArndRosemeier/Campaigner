import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppRouter } from '@/app/router';
import { artifactPath, battlePath, modulePath } from '@/app/routes';
import { createArtifact, listArtifactsByCampaign, publishToLibrary, updateArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createImage } from '@/db/imageRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { readSettings } from '@/db/settingsRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  modulePartSchema,
  moduleSpineSchema,
  type Campaign,
  type Id,
  type Module,
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

const { rewritePart, classifyEntityName, retrySpine, generateMissingParts, runParts } = await import('@/llm/moduleGen');
const rewriteMock = vi.mocked(rewritePart);
const generateMissingPartsMock = vi.mocked(generateMissingParts);
const runPartsMock = vi.mocked(runParts);
const classifyEntityNameMock = vi.mocked(classifyEntityName);
const retrySpineMock = vi.mocked(retrySpine);
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
  options: {
    part0Edited?: boolean;
    part0Markdown?: string;
    entityKinds?: ModuleEntityKind[];
    status?: Module['status'];
    errorMessage?: string;
  } = {},
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
    status: options.status ?? 'ready',
    errorMessage: options.errorMessage ?? '',
    spine,
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        markdown:
          options.part0Markdown ??
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
    // Play stays reachable from two places: the ToC sidebar and the reader
    // header (collapsing the sidebar must not hide the battle entry).
    const battleButtons = screen.getAllByRole('button', { name: 'Battle table' });
    expect(battleButtons.length).toBeGreaterThanOrEqual(2);
    for (const button of battleButtons) {
      expect(button).toHaveAttribute('href', battlePath(campaignId, moduleId));
    }

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

  it('renders the document article at the full pane width (no prose max-width cap)', async () => {
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));
    await findPartSection(0);

    const article = document.querySelector('article');
    if (article === null) throw new Error('reader article missing');
    // Owner directive: the middle pane must use its full width — the cap is
    // gone, comfortable padding and the type scale stay. The body size is
    // rem-based (0.9375rem = 15px at scale 1) so the in-app UI scale
    // (--ui-scale root multiplier) reaches the module text.
    expect(article.className).not.toContain('max-w-[70ch]');
    expect(article.className).not.toContain('mx-auto');
    expect(article.className).toContain('px-8');
    expect(article.className).toContain('py-10');
    expect(article.className).toContain('text-[0.9375rem]');
    await flushAsyncUpdates();
  });

  it('persists the opened module as settings.lastModule for the top-bar shortcut', async () => {
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));
    await findPartSection(0);

    await waitFor(async () => {
      const settings = await readSettings();
      expect(settings.lastModule).toMatchObject({ campaignId, moduleId, name: MODULE_TITLE });
    });
    // Re-mounting the same reader must not churn the row — the effect
    // writes only when the stored value differs.
    renderAppAt(modulePath(campaignId, moduleId));
    await findPartSection(0);
    await flushAsyncUpdates();
    const settings = await readSettings();
    expect(settings.lastModule).toMatchObject({ campaignId, moduleId, name: MODULE_TITLE });
  });

  it('shows module-failed-banner when module.status is failed and provides Resume button', async () => {
    const { campaignId, moduleId } = await seedReaderModule({
      status: 'failed',
      errorMessage: 'Model service unavailable (503)',
    });
    renderAppAt(modulePath(campaignId, moduleId));
    await findPartSection(0);

    const banner = await screen.findByTestId('module-failed-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Module generation encountered an error');
    expect(banner).toHaveTextContent('Model service unavailable (503)');

    const resumeBtn = within(banner).getByTestId('resume-module-generation');
    expect(resumeBtn).toBeInTheDocument();
    await flushAsyncUpdates();
  });

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
    const textarea = await within(part0).findByTestId('part-draft', {}, { timeout: 5_000 });
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

  it('edits with find/replace: counts, Enter navigation, case toggle, replace-one/all, save with edited:true', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule({
      part0Markdown: 'The lantern burns. A lantern gutters. LANTERN light.',
    });
    renderAppAt(modulePath(campaignId, moduleId));

    const part0 = await findPartSection(0);
    await user.click(within(part0).getByTestId('part-edit'));

    const editor = await within(part0).findByTestId('part-text-editor', {}, { timeout: 5_000 });
    const findInput = within(editor).getByTestId('part-find-input');
    await user.type(findInput, 'lantern');

    // Case-insensitive default: all three casings match.
    await waitFor(() => {
      expect(within(editor).getByTestId('part-find-count')).toHaveTextContent('1 / 3');
    });

    // Enter advances to the next match, Shift+Enter retreats (ReaderSearch
    // parity) — navigation moves the draft selection into view.
    await user.keyboard('{Enter}');
    expect(within(editor).getByTestId('part-find-count')).toHaveTextContent('2 / 3');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('part-draft');
    await user.click(findInput);
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(within(editor).getByTestId('part-find-count')).toHaveTextContent('1 / 3');

    // The case-sensitive toggle narrows to the two lowercase hits.
    await user.click(within(editor).getByTestId('part-case-toggle'));
    await waitFor(() => {
      expect(within(editor).getByTestId('part-find-count')).toHaveTextContent('1 / 2');
    });

    // Replace-one swaps the active (first) match.
    await user.type(within(editor).getByTestId('part-replace-input'), 'lamp');
    await user.click(within(editor).getByTestId('part-replace-one'));
    await waitFor(() => {
      expect(within(editor).getByTestId('part-draft')).toHaveValue(
        'The lamp burns. A lantern gutters. LANTERN light.',
      );
    });
    expect(within(editor).getByTestId('part-find-count')).toHaveTextContent('1 / 1');

    // Back to case-insensitive: two matches left; replace-all swaps both.
    await user.click(within(editor).getByTestId('part-case-toggle'));
    await waitFor(() => {
      expect(within(editor).getByTestId('part-find-count')).toHaveTextContent('1 / 2');
    });
    await user.click(within(editor).getByTestId('part-replace-all'));
    await waitFor(() => {
      expect(within(editor).getByTestId('part-draft')).toHaveValue(
        'The lamp burns. A lamp gutters. lamp light.',
      );
    });
    expect(within(editor).getByTestId('part-find-count')).toHaveTextContent('–');

    // Explicit Save commits through the existing savePartEdit path.
    await user.click(within(editor).getByTestId('part-edit-save'));
    await waitFor(
      async () => {
        const row = await getModule(moduleId);
        const part = row?.parts.find((entry) => entry.planIndex === 0);
        expect(part?.markdown).toBe('The lamp burns. A lamp gutters. lamp light.');
        expect(part?.edited).toBe(true);
        expect(part?.status).toBe('ready');
      },
      { timeout: 10_000 },
    );
    expect(toastSuccessMock).toHaveBeenCalledWith('Part saved');
    expect(await screen.findByTestId('part-body', {}, { timeout: 5_000 })).toBeInTheDocument();

    // The hand-edit flow never touches generation (no regression pins).
    expect(rewriteMock).not.toHaveBeenCalled();
    expect(generateMissingPartsMock).not.toHaveBeenCalled();
    expect(runPartsMock).not.toHaveBeenCalled();
    await flushAsyncUpdates();
  }, 30_000);

  it('cancels a part edit without touching the module row', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    const part0 = await findPartSection(0);
    await user.click(within(part0).getByTestId('part-edit'));
    const editor = await within(part0).findByTestId('part-text-editor', {}, { timeout: 5_000 });
    const draft = within(editor).getByTestId('part-draft');
    fireEvent.change(draft, { target: { value: 'discarded draft' } });
    await user.click(within(editor).getByTestId('part-edit-cancel'));

    // Edit mode exits, the rendered text is unchanged, the row is untouched.
    await waitFor(() => {
      expect(screen.getByTestId('part-body')).toBeInTheDocument();
    });
    const row = await getModule(moduleId);
    expect(row?.parts.find((entry) => entry.planIndex === 0)?.edited).toBe(false);
    expect(toastSuccessMock).not.toHaveBeenCalledWith('Part saved');
    await flushAsyncUpdates();
  }, 20_000);

  it('trips the rewrite overwrite confirm after a find/replace toolbar edit', async () => {
    const user = userEvent.setup();
    const { campaign, campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    // A toolbar edit (not a blur-save) marks the part hand-edited…
    const part0 = await findPartSection(0);
    await user.click(within(part0).getByTestId('part-edit'));
    const editor = await within(part0).findByTestId('part-text-editor', {}, { timeout: 5_000 });
    fireEvent.change(within(editor).getByTestId('part-draft'), {
      target: { value: 'Hand-edited through the find/replace toolbar.' },
    });
    await user.click(within(editor).getByTestId('part-edit-save'));
    await waitFor(
      async () => {
        const row = await getModule(moduleId);
        expect(row?.parts.find((entry) => entry.planIndex === 0)?.edited).toBe(true);
      },
      { timeout: 10_000 },
    );

    // …so the rewrite dialog warns before overwriting, exactly as after a
    // blur-save (the confirm reads `edited` off the module row, and part
    // markdown lives on the MODULE ROW — there is no artifact revision).
    await user.click(screen.getByTestId('part-rewrite'));
    const dialog = await screen.findByTestId('rewrite-dialog', {}, { timeout: 5_000 });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('hand-edited');
    await user.click(within(dialog).getByRole('button', { name: 'Rewrite part' }));
    expect(rewriteMock).toHaveBeenCalledTimes(1);
    expect(rewriteMock).toHaveBeenCalledWith(moduleId, campaign, 0, '');
    await flushAsyncUpdates();
  }, 20_000);

  it('resolves a global library entity in module text (B: reader resolution pool)', async () => {
    const { campaignId, moduleId } = await seedReaderModule({
      part0Markdown: 'The [[Wandering Blacksmith]] hammers at the ford before dawn.',
    });
    // A shared-library row: no campaign, no module (10-MILESTONE-6 C) —
    // published through the real adoption path.
    const row = await createArtifact({ campaignId, kind: 'npc', name: 'Wandering Blacksmith' });
    await publishToLibrary(row.id);
    renderAppAt(modulePath(campaignId, moduleId));

    const section = await findPartSection(0);
    const chip = await waitFor(() => {
      const found = within(section).getByTestId('wiki-chip');
      expect(found).toHaveAttribute('data-wiki-name', 'Wandering Blacksmith');
      return found;
    });
    expect(chip).toHaveAttribute('data-wiki-artifact-id');
  }, 20000);

  it('prefers the module-owned entity over a same-named campaign entity (tier-0)', async () => {
    const { campaignId, moduleId } = await seedReaderModule({
      part0Markdown: '[[Ash Cultist]] waits in the top room.',
    });
    // Same name twice: once campaign-scoped, once owned by this module.
    const campaignOnly = await createArtifact({
      campaignId,
      kind: 'npc',
      name: 'Ash Cultist',
    });
    const moduleOwned = await createArtifact({
      campaignId,
      moduleId,
      kind: 'npc',
      name: 'Ash Cultist',
    });

    renderAppAt(modulePath(campaignId, moduleId));
    const section = await findPartSection(0);
    await waitFor(() => {
      const chip = within(section).getByTestId('wiki-chip');
      expect(chip).toHaveAttribute('data-wiki-name', 'Ash Cultist');
      expect(chip).toHaveAttribute('data-wiki-artifact-id', moduleOwned.id);
    });
    // Sanity: the campaign row exists and was NOT the picked tier.
    expect(campaignOnly.id).not.toBe(moduleOwned.id);
  }, 20000);

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
    chatMock.mockResolvedValueOnce({ text: JSON.stringify({
        name: 'Missing Person',
        summary: 'Seen near the tower.',
        suggestedTags: [],
        body: '# Missing Person\nThey never came down.',
      }), modelUsed: 'test-model', fallback: null });
    renderAppAt(modulePath(campaignId, moduleId));

    const chip = await screen.findByTestId('wiki-chip-unresolved', {}, { timeout: 10_000 });
    await user.click(chip);
    const popover = await screen.findByTestId('stub-popover', {}, { timeout: 5_000 });
    await user.click(within(popover).getByTestId('stub-generate'));

    // The chain → runEngine → database path produces the artifact with the
    // module tag (same machinery as the batch) — and module-owned FROM BIRTH:
    // the chain step carried placementModuleId, so ownership never depended
    // on the post-run stamp surviving an interruption.
    await waitFor(
      async () => {
        const rows = await listArtifactsByCampaign(campaignId);
        const produced = rows.find((row) => row.name === 'Missing Person');
        expect(produced?.kind).toBe('note');
        expect(produced?.tags).toContain(`module:${MODULE_TITLE}`);
        expect(produced?.moduleId).toBe(moduleId);
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

  it('opens the workspace directly from an encounter panel row (no peek modal)', async () => {
    const user = userEvent.setup();
    const { campaignId, moduleId } = await seedReaderModule({
      part0Markdown: 'The [[Ford Ambush]] waits at the ford before dawn.',
    });
    const encounter = await createArtifact({
      campaignId,
      kind: 'encounter',
      name: 'Ford Ambush',
    });
    renderAppAt(modulePath(campaignId, moduleId));

    const rows = await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
    const ambushRow = rows.find((row) => row.textContent.includes('Ford Ambush'));
    if (ambushRow === undefined) throw new Error('Ford Ambush row not found in the entity panel');
    await user.click(ambushRow);

    // The encounter navigates straight to the workspace — the same target
    // as the peek modal's "Open in workspace" button — without peeking.
    await waitFor(
      () => {
        expect(window.location.pathname).toBe(artifactPath(campaignId, encounter.id));
      },
      { timeout: 10_000 },
    );
    expect(screen.queryByTestId('peek-modal')).not.toBeInTheDocument();
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

  it('the peek fullscreen viewer fills the viewport for an NPC image (fill + contain, upscale allowed)', async () => {
    const user = userEvent.setup();
    // jsdom lacks object URL support; the hooks revoke what they create.
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => `blob:mock-${Math.random()}`),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    const { campaignId, moduleId } = await seedReaderModule({
      part0Markdown: 'The [[Silt Warden]] collects the toll at the flooded gate.',
    });
    const npc = await createArtifact({ campaignId, kind: 'npc', name: 'Silt Warden' });
    const stored = await createImage({
      campaignId,
      blob: new Blob(['warden-bytes'], { type: 'image/png' }),
      mimeType: 'image/png',
      width: 1024,
      height: 1024,
      source: 'uploaded',
    });
    await updateArtifact(npc.id, { imageIds: [stored.id], coverImageId: stored.id });

    renderAppAt(modulePath(campaignId, moduleId));
    const rows = await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
    const wardenRow = rows.find((row) => row.textContent.includes('Silt Warden'));
    if (wardenRow === undefined) throw new Error('Silt Warden row not found in the entity panel');
    await user.click(wardenRow);

    const peek = await screen.findByTestId('peek-modal', {}, { timeout: 5_000 });
    const banner = await within(peek).findByTestId('peek-image', {}, { timeout: 5_000 });
    await user.click(banner);
    const fullscreen = await screen.findByTestId('peek-image-fullscreen', {}, { timeout: 5_000 });
    // Class-pin precedent (jsdom cannot measure pixels): the img must own the
    // WHOLE viewport so object-contain can scale UP past natural size — the
    // old shrink-only `max-h-full max-w-full` caps rendered a 1024×1024
    // generated image at half of a 2560px screen (owner report).
    const image = await within(fullscreen).findByAltText('Artifact image, large view', {}, { timeout: 5_000 });
    expect(image.className).toContain('h-dvh');
    expect(image.className).toContain('w-dvw');
    expect(image.className).toContain('object-contain');
    expect(image.className).toContain('max-h-[100dvh]');
    expect(image.className).toContain('max-w-[100dvw]');
    expect(image.className).not.toContain('max-h-full');
    expect(image.className).not.toContain('max-w-full');
    expect(image.className).not.toContain('w-auto');
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

  it('shows a failed first spine with its error and an in-place Retry', async () => {
    const user = userEvent.setup();
    await seedBuiltInPersonas();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
    const draft = createModule({
      campaignId: campaign.id,
      title: 'Doomed Draft',
      concept: 'A spine whose provider exploded.',
      levelMin: 1,
      levelMax: 2,
      sizeDial: 'sketch',
    });
    const failed = await saveModule({
      ...draft,
      status: 'failed',
      errorMessage: 'the provider exploded mid-draft',
    });
    renderAppAt(modulePath(campaign.id, failed.id));

    // The mocked retrySpine resolves; the component attaches .catch to it.
    retrySpineMock.mockResolvedValue(undefined);
    expect(await screen.findByTestId('spine-failed', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByTestId('spine-failed-error')).toHaveTextContent(
      'the provider exploded mid-draft',
    );

    await user.click(screen.getByTestId('retry-spine'));
    expect(retrySpineMock).toHaveBeenCalledTimes(1);
    expect(retrySpineMock).toHaveBeenCalledWith(failed.id, expect.anything());
    await flushAsyncUpdates();
  }, 20_000);

  it('bounds the entity rail and keeps the document as the flexing pane', async () => {
    const { campaignId, moduleId } = await seedReaderModule();
    renderAppAt(modulePath(campaignId, moduleId));

    await screen.findAllByTestId('entity-row', {}, { timeout: 10_000 });
    // jsdom cannot measure layout: pin the classes that keep the batch
    // toolbar from sizing the rail (flex min-width:auto).
    const aside = screen.getByTestId('entity-panel');
    for (const token of ['w-80', 'shrink-0', 'min-w-0']) {
      expect(aside.className.split(/\s+/)).toContain(token);
    }
    // The document stays the flexing pane — the rail never steals its width.
    const article = document.querySelector('[data-testid="module-reader"] article');
    if (article?.parentElement == null) throw new Error('reader document pane missing');
    expect(article.parentElement.className.split(/\s+/)).toContain('flex-1');
    await flushAsyncUpdates();
  }, 20_000);
});
