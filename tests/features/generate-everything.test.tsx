import 'fake-indexeddb/auto';

import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import { listModuleVersions } from '@/db/moduleVersionRepo';
import { saveSettings } from '@/db/settingsRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  defaultSettings,
  ENTITY_KINDS,
  modulePartSchema,
  moduleSpineSchema,
  type Artifact,
  type Campaign,
  type EncounterArtifactData,
  type EntityKind,
  type Module,
} from '@/domain';
import {
  deriveAutomationDeviation,
  deviationIsEmpty,
} from '@/features/modules/automation-deviation';
import { EntityPanel } from '@/features/modules/entity-panel';
import { resumeEverything, resumeModuleAutomation } from '@/features/modules/resume-automation';
import {
  FULL_AUTOMATION_TARGET,
  batchTargets,
  imageTargets,
  orderedKinds,
} from '@/features/modules/post-generation';
import { chainRunner } from '@/llm/chainRunner';
import { useProgressStore } from '@/lib/progress';
import type * as ModuleGenModule from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * "Generate everything" (owner request, verbatim: "In the entities sidebar i
 * would like to have a button 'generate everything' that just fills all
 * generation gaps. All entity details, all images, encounters, maps in
 * encounters... everything thats missing. Same way as its triggered in module
 * generation."; docs/17 row 80).
 *
 * What is pinned here: the TARGET is the full automation target (every
 * `ENTITY_KINDS` entry for details and images, battle maps and mob portraits on)
 * rather than the module's RECORDED intent, so a legacy row — which the
 * intent-bound "Resume automatic module creation" REFUSES — is served fully; the
 * module row's automation fields are never written to achieve it; the work is
 * additive (an existing artifact is never re-detailed, an existing image is
 * never re-queued); nothing missing means no batch call, no image enqueue and no
 * write; a not-ready module refuses loudly and runs nothing; the sidebar's
 * confirmation lists exactly the work the run does (the sweep's own detectors);
 * the control is passive with nothing missing and disabled with a REASON while a
 * generation is in flight; and the existing recorded-intent resume keeps its
 * refusal, drift and target semantics.
 *
 * Driven through the REAL seams — Dexie, the real entity chain, the real
 * detectors — with only the model, the background queues and the toasts mocked.
 */

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

// The two queues the sweep fills are suspended (spied, never pumped) — the
// contract is the ENQUEUE, exactly like the sweep's own suite. The hook itself
// stays subscribed by the entity panel, so it is a real zustand-shaped store
// over an EMPTY state: the panel renders live and the "in flight" pins drive the
// busy state through the module row instead.
const { enqueueImageJobs, enqueueEncounterMaps } = vi.hoisted(() => ({
  enqueueImageJobs: vi.fn(),
  enqueueEncounterMaps: vi.fn(),
}));

vi.mock('@/features/modules/entity-image-queue', () => {
  const state = {
    queued: [] as unknown[],
    active: [] as unknown[],
    failed: [] as unknown[],
    enqueue: enqueueImageJobs,
  };
  const store = (selector: (value: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  return { useEntityImageQueue: store };
});

vi.mock('@/features/modules/encounter-map-queue', () => {
  const state = {
    queued: [] as unknown[],
    active: [] as unknown[],
    failed: [] as unknown[],
    enqueue: enqueueEncounterMaps,
  };
  const store = (selector: (value: typeof state) => unknown) => selector(state);
  store.getState = () => state;
  return { useEncounterMapQueue: store };
});

vi.mock('@/llm/moduleGen', async (importOriginal) => {
  const original = await importOriginal<typeof ModuleGenModule>();
  return {
    ...original,
    // The classification pass is an LLM round-trip; its identity is pinned by
    // its own suite. Spied so a sentinel module can pin that the pass is NOT
    // needed when every name already carries a record.
    classifyNewModuleEntityNames: vi.fn(original.classifyNewModuleEntityNames),
  };
});

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { toastError, toastInfo, toastSuccess } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastInfoMock = vi.mocked(toastInfo);
const toastSuccessMock = vi.mocked(toastSuccess);
const { classifyNewModuleEntityNames } = await import('@/llm/moduleGen');
const classifyMock = vi.mocked(classifyNewModuleEntityNames);

/**
 * A valid draft reply for BOTH stub kinds this fixture's text names — the
 * location half and the npc half in one object (each persona's schema strips
 * the other's keys, `schemas.ts` draft contracts). ONE reply per detailed
 * entity; the batch aligns the produced artifact to the wiki-link name.
 */
const DRAFT = {
  name: 'Drafted',
  summary: 'The watchful keeper of the tide gate.',
  suggestedTags: ['warden'],
  body: '# Drafted\nIt keeps the gate.',
  // npc-draft
  appearance: 'Weathered leathers.',
  personality: 'Quiet.',
  needsStatBlock: false,
  // location-draft (event-draft is the same contract)
  locationType: 'dungeon',
  inhabitants: 'The tide wardens.',
  pointsOfInterest: [{ name: 'The Tide Gate', description: 'Rusted iron.' }],
  hooks: ['The gate opens at dusk.'],
};

const INTENT = {
  autoGenerateKinds: ['npc' as const],
  autoImageKinds: ['npc' as const],
  autoGenerateBattlemaps: false,
  autoGenerateMobImages: false,
};

interface World {
  campaign: Campaign;
  module: Module;
}

/**
 * A ready module whose RECORDED intent asks for npc entities + their images
 * only. `overrides` is how each test sets its own row up (a legacy row, a
 * drifted row, a failed row, a text naming other kinds).
 */
async function seedModule(overrides: Partial<Module> = {}): Promise<World> {
  const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });
  const base = createModule({
    campaignId: campaign.id,
    title: 'Ember Crypt',
    concept: 'A drowned crypt beneath the harbor.',
    levelMin: 1,
    levelMax: 1,
    sizeDial: 'sketch',
    autoGenerateKinds: INTENT.autoGenerateKinds,
    autoImageKinds: INTENT.autoImageKinds,
  });
  const module = await saveModule({
    ...base,
    status: 'ready',
    entityNamesNormalized: true,
    entityKinds: [
      { name: 'Kael', kind: 'npc', absorbed: [] },
      { name: 'Ember Crypt', kind: 'location', absorbed: [] },
    ],
    spine: moduleSpineSchema.parse({
      premise: 'The gate of [[Ember Crypt]] opens at dusk.',
      themes: [],
      partPlan: [{ title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    }),
    parts: [
      modulePartSchema.parse({
        planIndex: 0,
        status: 'ready',
        markdown: '## The Tide Gate\n\n[[Kael]] watches the gate and counts every visitor.',
        edited: false,
        errorMessage: '',
      }),
    ],
    ...overrides,
  });
  return { campaign, module };
}

/**
 * One resolved artifact (the owner's finished work). `imageId` null = the entity
 * is detailed but has NO image yet — the case the image step exists for.
 */
async function seedFinished(
  campaignId: string,
  moduleId: string,
  kind: EntityKind,
  name: string,
  imageId: string | null,
): Promise<Artifact> {
  // No `data`: the kind's own blank shape comes from the domain factory, so this
  // helper stays correct for every kind without a hand-kept data table.
  return createArtifact({
    campaignId,
    moduleId,
    kind,
    name,
    summary: 'already here',
    body: 'Do not touch me.',
    coverImageId: imageId,
  });
}

function renderPanel(world: World, artifacts: readonly Artifact[]): ReturnType<typeof rtlRender> {
  return rtlRender(
    <EntityPanel
      module={world.module}
      artifacts={artifacts}
      campaign={world.campaign}
      onStub={() => undefined}
      onOpenCard={() => undefined}
    />,
    { wrapper: MemoryRouter },
  );
}

/** The live artifact list, exactly as the reader hands it to the panel. */
async function panelArtifacts(world: World): Promise<Artifact[]> {
  return listArtifactsByCampaign(world.campaign.id);
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
  chatMock.mockReset();
  toastErrorMock.mockReset();
  toastInfoMock.mockReset();
  toastSuccessMock.mockReset();
  classifyMock.mockClear();
  enqueueImageJobs.mockReset();
  enqueueEncounterMaps.mockReset();
  chainRunner.reset();
  useProgressStore.getState().reset();
});

afterEach(() => {
  cleanup();
  chainRunner.reset();
  useProgressStore.getState().reset();
  vi.restoreAllMocks();
});

describe('the full automation target', () => {
  it('covers every ENTITY_KINDS entry for details AND for images, plus maps and mob portraits', () => {
    // Derived from the domain enum, not a hand-kept list: a kind added to
    // ENTITY_KINDS is in the target without touching the target.
    expect(orderedKinds(FULL_AUTOMATION_TARGET.autoGenerateKinds)).toEqual([...ENTITY_KINDS]);
    expect(orderedKinds(FULL_AUTOMATION_TARGET.autoImageKinds)).toEqual([...ENTITY_KINDS]);
    expect(FULL_AUTOMATION_TARGET.autoGenerateBattlemaps).toBe(true);
    expect(FULL_AUTOMATION_TARGET.autoGenerateMobImages).toBe(true);
  });

  it('names an entity of EVERY kind in the text as work, for details AND for images', async () => {
    // One wiki-link per domain kind, every one recorded, none resolved: the
    // deviation must report a gap for each of them, which is only possible if
    // the target really carries the whole enum (this is what the sidebar's
    // confirmation lists and what the run then batches, kind by kind).
    const names = ENTITY_KINDS.map((kind) => ({ name: `Sentinel ${kind}`, kind, absorbed: [] }));
    const { campaign, module } = await seedModule({
      entityKinds: names,
      spine: moduleSpineSchema.parse({
        premise: names.map((entry) => `[[${entry.name}]]`).join(' '),
        themes: [],
        partPlan: [{ title: 'The Tide Gate', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
      }),
      parts: [],
    });
    const artifacts = await panelArtifacts({ campaign, module });

    const deviation = deriveAutomationDeviation(module, artifacts, FULL_AUTOMATION_TARGET);

    // orderedKinds puts encounters last (the fixed-cast pin), every kind present.
    expect(deviation.entities.map((entry) => entry.kind)).toEqual([...ENTITY_KINDS]);
    expect(deviation.entities.map((entry) => entry.names)).toEqual(
      names.map((entry) => [entry.name]),
    );
    // Images follow the SAME enum: a resolved entity with no image is a gap for
    // every kind the target lists.
    expect(FULL_AUTOMATION_TARGET.autoImageKinds).toEqual([...ENTITY_KINDS]);
  }, 60_000);
});

describe('resumeEverything on a legacy row', () => {
  it('fills every gap of a module with no recorded intent — the case the intent-bound resume refuses', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });
    // The row itself asks for npc entities only; the FULL target goes further.
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    chatMock.mockResolvedValue({
      text: JSON.stringify(DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });
    const before = await getModule(module.id);

    const report = await resumeEverything(module.id, campaign);

    expect(report.refused).toBeNull();
    expect(report.swept).toBe(true);
    const artifacts = await listArtifactsByCampaign(campaign.id);
    // BOTH text-named entities exist: [[Kael]] (the row's configured kind) and
    // [[Ember Crypt]] (a kind the row's fields never asked for — only the full
    // target reaches it).
    expect(artifacts.map((artifact) => artifact.name).sort()).toEqual([
      'Ember Crypt',
      'Kael',
    ]);
    expect(toastErrorMock).not.toHaveBeenCalled();
    // The recorded-intent resume still refuses the very same row: the dead end
    // this control closes stays visibly a different control's answer.
    const legacy = await resumeModuleAutomation(module.id, campaign);
    expect(legacy.refused).toContain('no recorded automation intent');
    expect(legacy.swept).toBe(false);
    // No text rewrite: this action never snapshots or touches the prose.
    expect(await listModuleVersions(module.id)).toHaveLength(0);
    // Pin the row's automation fields are byte-identical afterwards.
    const after = await getModule(module.id);
    expect(after?.autoGenerateKinds).toEqual(before?.autoGenerateKinds);
    expect(after?.autoImageKinds).toEqual(before?.autoImageKinds);
    expect(after?.autoGenerateBattlemaps).toBe(before?.autoGenerateBattlemaps);
    expect(after?.autoGenerateMobImages).toBe(before?.autoGenerateMobImages);
    expect(after?.automationIntent).toBe(before?.automationIntent);
  }, 60_000);

  it('is additive: an existing artifact is never re-detailed and an existing image never re-queued', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });
    const crypt = await seedFinished(
      campaign.id,
      module.id,
      'location',
      'Ember Crypt',
      '00000000-0000-4000-8000-00000000c001',
    );
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    chatMock.mockResolvedValue({
      text: JSON.stringify(DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });

    const report = await resumeEverything(module.id, campaign);

    expect(report.swept).toBe(true);
    const artifacts = await listArtifactsByCampaign(campaign.id);
    const after = artifacts.find((artifact) => artifact.id === crypt.id);
    expect(after?.body).toBe('Do not touch me.');
    expect(after?.currentRevision).toBe(1);
    expect(after?.coverImageId).toBe('00000000-0000-4000-8000-00000000c001');
    // Only the entity that was actually missing is queued for an image.
    expect(enqueueImageJobs).toHaveBeenCalledWith([
      { campaignId: campaign.id, moduleId: module.id, name: 'Kael' },
    ]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 60_000);

  it('does nothing at all when there is nothing missing: no batch call, no enqueue, no write', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });
    await seedFinished(campaign.id, module.id, 'npc', 'Kael', '00000000-0000-4000-8000-00000000c002');
    await seedFinished(
      campaign.id,
      module.id,
      'location',
      'Ember Crypt',
      '00000000-0000-4000-8000-00000000c003',
    );
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    const before = await getModule(module.id);

    const report = await resumeEverything(module.id, campaign);

    expect(report).toEqual({
      empty: true,
      refused: null,
      classified: [],
      normalized: false,
      swept: false,
      stopped: false,
    });
    expect(chatMock).not.toHaveBeenCalled();
    expect(classifyMock).not.toHaveBeenCalled();
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(enqueueEncounterMaps).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(await listModuleVersions(module.id)).toHaveLength(0);
    const after = await getModule(module.id);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  }, 60_000);

  it('refuses a module whose parts pass did not finish, and runs nothing', async () => {
    const { campaign, module } = await seedModule({
      automationIntent: null,
      status: 'failed',
      errorMessage: 'Encounter floor not met: …',
    });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    const report = await resumeEverything(module.id, campaign);

    expect(report.refused).toContain('parts pass did not finish');
    expect(report.swept).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
    expect(enqueueImageJobs).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('parts pass did not finish'),
    );
  }, 60_000);
});

describe('the entity sidebar control', () => {
  it('is absent (a passive statement instead) when the full target has no gap', async () => {
    const { campaign, module } = await seedModule();
    await seedFinished(campaign.id, module.id, 'npc', 'Kael', '00000000-0000-4000-8000-00000000d001');
    await seedFinished(
      campaign.id,
      module.id,
      'location',
      'Ember Crypt',
      '00000000-0000-4000-8000-00000000d002',
    );

    renderPanel({ campaign, module }, await panelArtifacts({ campaign, module }));

    // Never a permanently disabled button: with nothing missing the control is
    // not rendered at all, and its place says so.
    expect(screen.queryByTestId('generate-everything')).toBeNull();
    expect(screen.getByTestId('generate-everything-none')).toHaveTextContent('Nothing missing');
  }, 60_000);

  it('appears with the work count and lists EXACTLY what the sweep would do', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });
    const artifacts = await panelArtifacts({ campaign, module });

    renderPanel({ campaign, module }, artifacts);

    const button = screen.getByTestId('generate-everything');
    // The count IS the deviation's own work count (two text-named entities with
    // no artifact, and no image follows from a missing artifact).
    expect(button).toHaveTextContent(/^Generate everything \(\d+\)$/);
    await userEvent.click(button);

    const dialog = await screen.findByTestId('generate-everything-dialog');
    const lines = within(dialog)
      .getAllByTestId('generate-everything-line')
      .map((line) => line.textContent);
    // The confirmation is the sweep's own detectors over the SAME pool, so it can
    // neither promise work the sweep would skip nor hide work it would run.
    expect(lines).toContain(
      '1 location named by the text but not generated yet: Ember Crypt',
    );
    expect(lines).toContain('1 npc named by the text but not generated yet: Kael');
    expect(lines.some((line) => line.includes('without an image'))).toBe(false);
    // And the boundary is stated where the owner asks for it.
    expect(within(dialog).getByText(/never rewritten and no scene is created/i)).toBeTruthy();
  }, 60_000);

  it('appears for an encounter whose un-imaged mobs are all materialized CORE creatures (owner report)', async () => {
    // The owner report (docs/17 row 96), verbatim: *"Same with the generate all
    // button, its not there although some encounter mobs do not have images."*
    // Everything the full target asks for is finished EXCEPT the encounter's mob
    // portraits: both text-named entities exist with their images, the encounter
    // carries its battlemap — and its roster is the shape the old rulebook-only
    // detector could not see: an `npc-ref` to the artifact a CORE creature was
    // materialized into (the marker is on that row), plus an uncited entry.
    const { campaign, module } = await seedModule({ automationIntent: null });
    await seedFinished(campaign.id, module.id, 'npc', 'Kael', '00000000-0000-4000-8000-00000000d001');
    await seedFinished(
      campaign.id,
      module.id,
      'location',
      'Ember Crypt',
      '00000000-0000-4000-8000-00000000d002',
    );
    const cube = await createArtifact({
      campaignId: campaign.id,
      kind: 'npc',
      name: 'Gelatinous Cube',
      summary: '',
      body: '',
      coverImageId: null,
      data: {
        appearance: '',
        personality: '',
        statBlock: null,
        // A CAST creature npc (docs/11 D3/D4): an authored row whose stats come
        // from the library. The retired `monsterChunkId` was the hidden marker
        // that made a bestiary row look like a campaign mob artifact.
        creatureRef: { chunkId: '00000000-0000-4000-8000-00000000c001' },
      },
    });
    // The encounter data shape, typed ONCE (an inline literal against the
    // artifact-data union narrows its members to `never`).
    const data: EncounterArtifactData = {
      difficulty: 'medium',
      levelHint: '1',
      monsters: [
        {
          name: 'Gelatinous Cube',
          count: 1,
          notes: '',
          treasure: '',
          source: { type: 'npc-ref', artifactId: cube.id },
        },
        { name: 'Bog Lurker', count: 2, notes: '', treasure: '', source: { type: 'none' } },
      ],
      terrain: '',
      tactics: '',
      treasure: '',
      mapImageId: '00000000-0000-4000-8000-00000000d003',
      layout: {
        gridW: 20,
        gridH: 20,
        theme: 'crypt',
        rooms: [
          {
            id: '00000000-0000-4000-8000-00000000d004',
            name: 'The Tide Gate',
            rects: [{ x: 1, y: 1, w: 5, h: 5 }],
            mobsRect: { x: 1, y: 1, w: 5, h: 5 },
            description: '',
            monsterIndexes: [],
            spawn: true,
            key: '',
            keyTreasure: '',
          },
        ],
        corridors: [],
      },
      preset: 'standard',
      locationKind: 'other',
      siteShape: 'single',
      budgetAdvisory: '',
    };
    await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'Ash Gate',
      summary: '',
      body: '',
      data,
    });

    renderPanel({ campaign, module }, await panelArtifacts({ campaign, module }));

    // Before the fix this control was not rendered at all (its derivation came
    // out EMPTY), and its place said "Nothing missing".
    const button = screen.getByTestId('generate-everything');
    await userEvent.click(button);

    const dialog = await screen.findByTestId('generate-everything-dialog');
    const lines = within(dialog)
      .getAllByTestId('generate-everything-line')
      .map((line) => line.textContent);
    // The portrait gap is the ONLY thing left, and the confirmation NAMES the
    // encounter it belongs to — the same line the sweep's own detector produces
    // for the same encounter.
    expect(lines).toEqual(['Mob portraits missing for 1 encounter: Ash Gate']);
  }, 60_000);

  it('fills the gaps the confirmation listed, through the same run', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    chatMock.mockResolvedValue({
      text: JSON.stringify(DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });
    renderPanel({ campaign, module }, await panelArtifacts({ campaign, module }));

    await userEvent.click(screen.getByTestId('generate-everything'));
    const dialog = await screen.findByTestId('generate-everything-dialog');
    // The names the confirmation promised, from its OWN lines (the text after
    // the final colon) — the promise and the run are then compared by name.
    const promised = within(dialog)
      .getAllByTestId('generate-everything-line')
      .flatMap((line) => {
        const text = line.textContent;
        return text
          .slice(text.lastIndexOf(':') + 1)
          .split(',')
          .map((name) => name.trim())
          .filter((name) => name !== '');
      });
    expect(promised.sort()).toEqual(['Ember Crypt', 'Kael']);

    await userEvent.click(within(dialog).getByTestId('generate-everything-confirm'));

    await waitFor(() => {
      expect(enqueueImageJobs).toHaveBeenCalled();
    });
    // Every name the confirmation named now has its artifact — the promise and
    // the run agree.
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts.map((artifact) => artifact.name).sort()).toEqual([
      'Ember Crypt',
      'Kael',
    ]);
    expect(toastErrorMock).not.toHaveBeenCalled();
    // Every promised name is an artifact now: the promise and the run agree.
    for (const name of promised) {
      expect(artifacts.some((artifact) => artifact.name === name)).toBe(true);
    }
    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('Module automation'));
    });
  }, 60_000);

  it('is disabled with the REASON while the module is generating', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null, status: 'generating' });

    renderPanel({ campaign, module }, await panelArtifacts({ campaign, module }));

    const button = screen.getByTestId('generate-everything');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'The module is generating right now — wait for it (or press Stop).',
    );
    // …and the SAME sentence is perceivable, not merely present: a `title` on a
    // natively disabled button never renders in Chrome (no pointer event reaches
    // it — the shadcn Button carries `disabled:pointer-events-none` on top) and
    // is unreachable by keyboard, so the shared blocked-control device carries
    // it and associates it for AT (docs/18 §2.3).
    const reason = screen.getByTestId('generate-everything-reason');
    expect(reason).toHaveTextContent(
      'The module is generating right now — wait for it (or press Stop).',
    );
    expect(screen.getByTestId('generate-everything-blocked')).toHaveAttribute(
      'aria-describedby',
      reason.id,
    );
  }, 60_000);

  it('names the text path as the reason when the parts pass failed', async () => {
    const { campaign, module } = await seedModule({
      automationIntent: null,
      status: 'failed',
      errorMessage: 'Encounter floor not met: the module needs 1 distinct named encounters',
    });

    renderPanel({ campaign, module }, await panelArtifacts({ campaign, module }));

    const button = screen.getByTestId('generate-everything');
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toContain('fix the text first');
  }, 60_000);

  it('reports a finished run in the sidebar, not only in the dock', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    chatMock.mockResolvedValue({
      text: JSON.stringify(DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });
    renderPanel({ campaign, module }, await panelArtifacts({ campaign, module }));

    await userEvent.click(screen.getByTestId('generate-everything'));
    const dialog = await screen.findByTestId('generate-everything-dialog');
    await userEvent.click(within(dialog).getByTestId('generate-everything-confirm'));

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining('Module automation'));
    });
    // No refusal toast: the run was accepted and reported.
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 60_000);
});

describe('the recorded-intent resume is unchanged', () => {
  it('still refuses a drifted row instead of filling it with the full target', async () => {
    const { campaign, module } = await seedModule({ autoGenerateKinds: [] });
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report.refused).toContain('no longer match');
    expect(report.swept).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
    expect(enqueueImageJobs).not.toHaveBeenCalled();
  }, 60_000);

  it('still refuses a legacy row — with the sidebar control named as the remedy', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report.empty).toBe(true);
    expect(report.refused).toContain('no recorded automation intent');
    expect(report.refused).toContain('Generate everything');
    expect(report.swept).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
  }, 60_000);

  it('never writes the row automation fields, even when the sweep runs for an explicit target', async () => {
    const { campaign, module } = await seedModule();
    await saveSettings({ ...defaultSettings(), imagesEnabled: true });
    chatMock.mockResolvedValue({
      text: JSON.stringify(DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });
    const before = await getModule(module.id);

    await resumeEverything(module.id, campaign);

    const after = await getModule(module.id);
    // The row's fields are the persisted record of what creation was asked to
    // automate (docs/17 row 71): identical bytes, no temporary write.
    expect({
      autoGenerateKinds: after?.autoGenerateKinds,
      autoImageKinds: after?.autoImageKinds,
      autoGenerateBattlemaps: after?.autoGenerateBattlemaps,
      autoGenerateMobImages: after?.autoGenerateMobImages,
      automationIntent: after?.automationIntent,
    }).toEqual({
      autoGenerateKinds: before?.autoGenerateKinds,
      autoImageKinds: before?.autoImageKinds,
      autoGenerateBattlemaps: before?.autoGenerateBattlemaps,
      autoGenerateMobImages: before?.autoGenerateMobImages,
      automationIntent: before?.automationIntent,
    });
  }, 60_000);

  it('still resumes exactly the recorded intent when the intent is what is asked for', async () => {
    const { campaign, module } = await seedModule();
    // [[Ember Crypt]] is a location the RECORDED intent never asked for: the
    // intent-bound resume must leave it alone while the full target fills it.
    await saveSettings({ ...defaultSettings(), imagesEnabled: false });
    chatMock.mockResolvedValue({
      text: JSON.stringify(DRAFT),
      modelUsed: 'test-model',
      fallback: null,
    });

    const report = await resumeModuleAutomation(module.id, campaign);

    expect(report.swept).toBe(true);
    const artifacts = await listArtifactsByCampaign(campaign.id);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(['Kael']);
  }, 60_000);
});

describe('the deviation derivation, parameterized', () => {
  it('reports a legacy row empty without a target and fully served with one', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });
    const artifacts = await panelArtifacts({ campaign, module });
    // Two targets, one derivation: the recorded intent keeps the legacy row
    // inert, the explicit target serves it.
    expect(deviationIsEmpty(deriveAutomationDeviation(module, artifacts))).toBe(true);
    const full = deriveAutomationDeviation(module, artifacts, FULL_AUTOMATION_TARGET);
    expect(deviationIsEmpty(full)).toBe(false);
    expect(full.entities.map((entry) => entry.kind).sort()).toEqual(['location', 'npc']);
    // The detectors are the sweep's OWN target sets, name for name.
    for (const entry of full.entities) {
      expect(entry.names).toEqual(batchTargets(module, artifacts, entry.kind));
    }
    expect(full.images).toEqual([]);
  }, 60_000);

  it('agrees with the sweep about images on resolved, unimaged entities', async () => {
    const { campaign, module } = await seedModule({ automationIntent: null });
    await seedFinished(campaign.id, module.id, 'npc', 'Kael', '00000000-0000-4000-8000-00000000e001');
    // [[Ember Crypt]] is detailed but has no image yet.
    await seedFinished(campaign.id, module.id, 'location', 'Ember Crypt', null);
    const artifacts = await panelArtifacts({ campaign, module });
    const full = deriveAutomationDeviation(module, artifacts, FULL_AUTOMATION_TARGET);

    // [[Kael]] resolves and carries an image; [[Ember Crypt]] resolves with none.
    // An entity with NO artifact is never an image target: there is nothing to
    // attach a cover to yet (the batch above creates it first).
    expect(imageTargets(module, artifacts, 'npc')).toEqual([]);
    expect(imageTargets(module, artifacts, 'location')).toEqual(['Ember Crypt']);
    expect(full.entities).toEqual([]);
    expect(full.images).toEqual([{ kind: 'location', names: ['Ember Crypt'] }]);
  }, 60_000);
});
