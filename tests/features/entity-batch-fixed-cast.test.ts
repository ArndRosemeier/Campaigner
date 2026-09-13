import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';

import { createArtifact, getArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createModule, type Campaign, type Module, type PersonaRun, type StatBlock } from '@/domain';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { runEntityBatch } from '@/features/modules/entity-batch';
import {
  BATCH_FAILURE_CONSOLE_PREFIX,
  BATCH_FAILURE_RECORD_TAG,
} from '@/features/modules/entity-batch-report';
import type * as runEngineModule from '@/llm/runEngine';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * Fixed-cast glue at the batch seam (docs/11): encounter briefs build after
 * the NPC/monster results land, so the brief pins the drafted scene members
 * as fixed cast; NPC briefs carry the structured level line. The engine is
 * mocked here — the brief STRING is the assertion target (full-run behavior
 * is pinned in tests/llm/fixedCast.test.ts).
 */

const { startRunMock, waitForRunStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  waitForRunStatusMock: vi.fn(),
}));

// The engine is faked (this file pins brief STRINGS), but the withdrawal
// predicate is the REAL one: `runEntityBatch` reads it to tell an owner stop
// from a failure (docs/17 row 117), and a mock that re-implemented that rule
// would judge the fold against a fake. The reason seam is REAL for the same
// reason (docs/18 §2, `runNotCompletedReason`): the per-entity failure pins
// below judge the sentence the site actually emits.
vi.mock('@/llm/runEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof runEngineModule>();
  return {
    isRunWithdrawn: actual.isRunWithdrawn,
    runNotCompletedReason: actual.runNotCompletedReason,
    runEngine: { on: () => () => undefined, startRun: startRunMock },
    waitForRunStatus: waitForRunStatusMock,
  };
});

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const HALVAR_STATS: StatBlock = {
  system: 'dnd5e',
  level: '6',
  size: 'Large',
  creatureType: 'giant',
  ac: 15,
  acNote: '',
  hp: 45,
  hpFormula: '6d10+12',
  speed: '30 ft.',
  abilities: { str: 18, dex: 10, con: 14, int: 8, wis: 10, cha: 8 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Giant',
  traits: [],
  actions: [{ name: 'Club', text: 'Melee Weapon Attack: +6 to hit.' }],
  reactions: [],
  legendary: [],
  extras: {},
};

async function seedWorld(): Promise<{ campaign: Campaign; module: Module; halvarId: string }> {
  const campaign = await createCampaign({ name: 'Pit Campaign', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Pit Module',
    concept: 'concept',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'standard',
  });
  const module = await saveModule({
    ...draft,
    spine: {
      premise: 'Pit premise.',
      themes: [],
      writerModel: '',
      origin: null,
      partPlan: [{ title: 'Descent', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    parts: [
      {
        planIndex: 0,
        markdown:
          'The pit mouth gapes. [[Halvar]] the giant stands beside ' +
          '[[The Howling Pit]], daring the party to enter.',
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: '',
        origin: null,
      },
    ],
  });
  // Halvar is ALREADY drafted (an earlier NPC batch landed him).
  const halvar = await createArtifact({
    campaignId: campaign.id,
    moduleId: module.id,
    kind: 'npc',
    name: 'Halvar',
    summary: 'A giant blocking the pit.',
    body: 'Halvar stands in the way.',
    links: [],
    data: { appearance: 'Huge', personality: 'Gruff', statBlock: HALVAR_STATS },
  });
  await seedBuiltInPersonas();
  return { campaign, module, halvarId: halvar.id };
}

function completedWith(artifactId: string): PersonaRun {
  return { status: 'completed', resultArtifactId: artifactId, errorMessage: '' } as unknown as PersonaRun;
}

/** A run that died on its own, with the sentence the engine composed. */
function failedWith(errorMessage: string): PersonaRun {
  return {
    status: 'failed',
    resultArtifactId: null,
    errorMessage,
    failureKind: null,
  } as unknown as PersonaRun;
}

/** A run the PAGE killed: exactly what `db/runRepo.failRunningRuns` writes on
 * app start (status `failed`, so the withdrawal predicate does NOT silence it,
 * plus the classification that says it was not the generator). */
function interruptedByReload(): PersonaRun {
  return {
    status: 'failed',
    resultArtifactId: null,
    errorMessage: 'Interrupted by reload',
    failureKind: 'cancelled',
  } as unknown as PersonaRun;
}

/** A withdrawn run — the owner's own Stop (docs/17 row 117). */
function cancelled(): PersonaRun {
  return { status: 'cancelled', resultArtifactId: null, errorMessage: '' } as unknown as PersonaRun;
}

function briefs(): string[] {
  return startRunMock.mock.calls.map((call) => {
    const input = call[0] as { brief?: unknown };
    return typeof input.brief === 'string' ? input.brief : '';
  });
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  startRunMock.mockReset();
  waitForRunStatusMock.mockReset();
  toastErrorMock.mockReset();
});

/** A `[campaigner] entity-batch failure {…}` line, parsed back into its record.
 * The tag is the contract: it is what makes the line greppable and the JSON
 * what makes it pasteable. */
function recordLines(spy: MockInstance<(...data: unknown[]) => void>): Record<string, unknown>[] {
  const prefix = `${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_FAILURE_RECORD_TAG} `;
  return spy.mock.calls
    .map((call) => call[0])
    .filter((value): value is string => typeof value === 'string' && value.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
}

describe('encounter batch briefs pin the landed fixed cast', () => {
  it('the brief carries the scene NPC summary plus the must-appear instruction', async () => {
    const { campaign, module } = await seedWorld();
    const encounter = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'encounter',
      name: 'The Howling Pit',
      summary: 'A pit fight.',
      body: 'The pit.',
      links: [],
      data: {
        difficulty: '',
        levelHint: '1',
        monsters: [],
        terrain: '',
        tactics: '',
        treasure: '',
        mapImageId: null,
        preset: 'standard',
        locationKind: 'other',
        siteShape: 'single',
        budgetAdvisory: '',
        layout: null,
      },
    });
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(completedWith(encounter.id));

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'encounter',
      targets: [{ name: 'The Howling Pit' }],
    });

    expect(result.failed).toEqual([]);
    expect(result.generated).toEqual(['The Howling Pit']);
    expect(startRunMock).toHaveBeenCalledTimes(1);
    const [brief] = briefs();
    expect(brief).toContain('Party of 4 adventurers at level 1.');
    expect(brief).toContain('Fixed cast');
    expect(brief).toContain('"Halvar"');
    expect(brief).toContain('level 6');
    expect(brief).toContain('MUST appear');
    expect(brief).toContain('as-is');
    expect(brief).toContain('REST of the roster');
  });
});

describe('NPC batch briefs carry the structured level', () => {
  it('the brief carries the part level line and no fixed cast', async () => {
    const { campaign, module, halvarId } = await seedWorld();
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(completedWith(halvarId));

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Halvar' }],
    });

    expect(result.failed).toEqual([]);
    expect(startRunMock).toHaveBeenCalledTimes(1);
    const [brief] = briefs();
    expect(brief).toContain('Party of 4 adventurers at level 1.');
    expect(brief).not.toContain('Fixed cast');
  });
});

/**
 * A batch entity whose run did not complete, and the ONE sentence seam that
 * says why (docs/18 §2, `runNotCompletedReason`; docs/17 row 128). The engine
 * is faked above but the seam is REAL — these pins judge the sentence the SITE
 * emits, so a reworded copy there would have to be re-implemented to survive
 * them.
 */
describe('a batch entity whose run did not complete says WHY through the engine’s one seam', () => {
  it('reports the engine’s own sentence verbatim — never a reworded fragment', async () => {
    const { campaign, module } = await seedWorld();
    const sentence =
      'Step "draft" rejected: the model reply could not be parsed. The run failed without saving partial results — run it again.';
    const run = failedWith(sentence);
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(run);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    // Byte-identical to what the engine wrote: no status, no label, no
    // wrapper — the message IS the sentence. The rest of the record is what
    // the reporting seam reads (docs/17 row 131): which path, which run, its
    // terminal status, and the RAW engine row behind the sentence.
    const [failure] = result.failed;
    expect(failure).toEqual({
      name: 'Kael',
      kind: 'run-not-completed',
      message: sentence,
      runId: 'run-1',
      status: 'failed',
      errorMessage: sentence,
      raw: run,
    });
    // …and the raw row survives by IDENTITY (a copy would prove nothing about
    // what the reporting layer actually receives).
    expect(failure?.raw).toBe(run);
    expect(result.generated).toEqual([]);
    // The failure list IS this seam's loud surface (it is what the caller
    // throws at the owner — pinned in `tests/features/change-artifact.test.ts`,
    // "a batch failure is thrown with the specialist reason, never returned as
    // a quiet status"), and exactly one entity is reported: never swallowed,
    // never duplicated.
    expect(result.failed).toHaveLength(1);
  });

  it('falls back to `run ended <status>` when the engine wrote nothing', async () => {
    const { campaign, module } = await seedWorld();
    const run = failedWith('');
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(run);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    expect(result.failed).toEqual([
      {
        name: 'Kael',
        kind: 'run-not-completed',
        message: 'run ended failed',
        runId: 'run-1',
        status: 'failed',
        errorMessage: '',
        raw: run,
      },
    ]);
  });

  it('a run the PAGE killed is its OWN class, and carries the reload’s own classification', async () => {
    const { campaign, module } = await seedWorld();
    const run = interruptedByReload();
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(run);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    // The asymmetry that made this a class of its own: `isRunWithdrawn` reads
    // `status === 'cancelled'` (the owner's Stop), so a run the RELOAD killed
    // — `status: 'failed'` with `failureKind: 'cancelled'` — lands in the
    // failure list. Without the classification it would reach the owner as
    // "N of M npcs failed to generate", i.e. as a broken generator.
    expect(result.failed).toEqual([
      {
        name: 'Kael',
        kind: 'interrupted',
        message: 'Interrupted by reload',
        runId: 'run-1',
        status: 'failed',
        failureKind: 'cancelled',
        errorMessage: 'Interrupted by reload',
        raw: run,
      },
    ]);
    expect(result.generated).toEqual([]);
  });

  it('the failure is WRITTEN DOWN when it happens — the record survives a batch that never reaches its end report', async () => {
    const { campaign, module } = await seedWorld();
    const sentence = 'Step "draft" rejected: the model reply could not be parsed.';
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(failedWith(sentence));
    // A spy replaces the console-hygiene guard's own wrapper, so a file that
    // drives failing batches can assert the record instead of muting it.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // NO caller reports this batch: `runEntityBatch` is called on its own, which
    // is exactly the situation the owner described — a batch that dies
    // mid-flight (a page reload, his Stop, a throw) never reaches the
    // batch-END report, and an end-of-batch-only dump would have left him with
    // nothing to paste.
    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }, { name: 'Bram' }],
    });
    expect(result.failed).toHaveLength(2);

    const records = recordLines(consoleSpy);
    expect(records).toHaveLength(2);
    const kael = records.find((record) => record.name === 'Kael');
    // Everything needed to diagnose without guessing: which entity, which path,
    // which run, the run's own terminal status and sentence — plus the batch
    // the failure belongs to.
    expect(kael?.kind).toBe('run-not-completed');
    expect(kael?.message).toBe(sentence);
    expect(kael?.status).toBe('failed');
    expect(kael?.batchKind).toBe('npc');
    expect(kael?.total).toBe(2);
    const moduleField = kael?.module as { title: string };
    expect(moduleField.title).toBe('The Pit Module');
    // One line, ONE string argument — so "copy this line" is faithful in any
    // devtools rather than a devtools-specific preview.
    expect(consoleSpy.mock.calls[0]).toHaveLength(1);
    expect(consoleSpy.mock.calls[0]?.[0]).toContain(`${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_FAILURE_RECORD_TAG} `);
    consoleSpy.mockRestore();
  });

  it('a run the OWNER stopped is still WITHDRAWN here: no failure entry and no red toast (row 117’s silence holds)', async () => {
    const { campaign, module } = await seedWorld();
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(cancelled());

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    // The predicate answers BEFORE the reason seam is ever reached, which is
    // the whole separation the seam documents: a sentence exists for this row
    // (`run ended cancelled`) and the owner still never hears it.
    expect(result.failed).toEqual([]);
    expect(result.generated).toEqual([]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

/** A cast creature's citation — the field `isCastCreatureNpc` reads. */
const CHUNK_ID = '5a4f0c9e-1111-4111-8111-000000000001';

/**
 * The RECORD every failure now is (docs/17 row 131): the three paths an
 * entity can end up without an artifact are three different FACTS, and the
 * reporting seam can only tell the owner which one he hit if the record
 * carries it. Each pin below drives one path at the batch and asserts the
 * whole record, `raw` by IDENTITY (a deep-equal copy of an object the site
 * never passed would pass a shape pin and prove nothing about what the
 * reporting layer receives — lesson 4).
 */
describe('a batch failure records WHICH path it came down, with the raw evidence', () => {
  it('a run that landed on a CAST CREATURE npc is REFUSED — a designed stop, with the row it would have overwritten', async () => {
    const { campaign, module } = await seedWorld();
    const cast = await createArtifact({
      campaignId: campaign.id,
      moduleId: module.id,
      kind: 'npc',
      name: 'Zombie',
      summary: '',
      body: '',
      links: [],
      data: { appearance: '', personality: '', statBlock: null, creatureRef: { chunkId: CHUNK_ID } },
    });
    const run = completedWith(cast.id);
    startRunMock.mockResolvedValue('run-1');
    waitForRunStatusMock.mockResolvedValue(run);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    const [failure] = result.failed;
    expect(failure?.name).toBe('Kael');
    // A DESIGNED stop is named as one — never an anonymous "failed to generate".
    expect(failure?.kind).toBe('refused');
    expect(failure?.message).toContain("is this campaign's own npc for a library creature");
    // …and the refusal sentence carries the way OUT (the seam's own wording).
    expect(failure?.message).toContain('make a separate npc of that name');
    expect(failure?.runId).toBe('run-1');
    // The run COMPLETED: the refusal is the BATCH's, which is exactly why the
    // Runs tab cannot show this as a failed run.
    expect(failure?.status).toBe('completed');
    // The raw evidence is the row the write was refused for. Content equality
    // is the ONLY assertion available at this path, and that limit is
    // MEASURED rather than assumed: the batch reads it through
    // `artifactRepo.getArtifact`, which parses the stored row, so every read
    // (the batch's and this test's) is a fresh object — an identity pin here
    // would fail against correct code. Identity IS pinned where the site hands
    // a value over untouched: the run row below and the thrown value.
    expect(failure?.raw).toEqual(cast);
    expect((failure?.raw as { data: { creatureRef?: unknown } }).data.creatureRef).toEqual({
      chunkId: CHUNK_ID,
    });
    expect(result.generated).toEqual([]);
    // The refusal is a TRUE no-op: the cast row is untouched.
    expect((await getArtifact(cast.id))?.name).toBe('Zombie');
  });

  it('a setup throw keeps the THROWN VALUE, and names no run when none was started', async () => {
    const { campaign, module } = await seedWorld();
    const thrown = new Error('No API key configured — add one in Settings');
    startRunMock.mockRejectedValue(thrown);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    const [failure] = result.failed;
    expect(failure?.kind).toBe('setup-error');
    expect(failure?.message).toBe('No API key configured — add one in Settings');
    // No run was started, so there is no id to point at — an honest absence,
    // never a fabricated one.
    expect(failure?.runId).toBeUndefined();
    expect(failure?.status).toBeUndefined();
    // The thrown object itself, not the sentence `errorMessage` made of it.
    expect(failure?.raw).toBe(thrown);
  });

  it('a VALIDATION throw keeps its zod issues as objects (never a JSON wall in a string)', async () => {
    const { campaign, module } = await seedWorld();
    const parsed = z.object({ name: z.string() }).safeParse({});
    if (parsed.success) throw new Error('fixture should fail validation');
    startRunMock.mockRejectedValue(parsed.error);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: 'Kael' }],
    });

    const [failure] = result.failed;
    expect(failure?.kind).toBe('setup-error');
    // `errorMessage` flattens a ZodError to its raw issues array — the record
    // keeps the ERROR, so the reporting layer can still read the issues.
    expect(failure?.message).toContain('invalid_type');
    expect(failure?.raw).toBe(parsed.error);
    expect((failure?.raw as z.ZodError).issues).toHaveLength(1);
  });
});
