import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * The seam runs the REAL `lib/toast` and the REAL `lib/zodErrorSummary`; only
 * `sonner` (the framework boundary the toast seam talks to) is faked. That is
 * deliberate: the DURATION this brief had to decide on lives in the options
 * object `lib/toast` builds, so a pin that mocked `lib/toast` itself could not
 * see it and would pass against a transient toast.
 */
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn() },
}));

import { toast } from 'sonner';
import { z } from 'zod';

import { createCampaign, createModule, moduleSchema, type Campaign, type Module, type PersonaRun } from '@/domain';
import type { EntityBatchFailure } from '@/features/modules/entity-batch';
import {
  BATCH_FAILURE_CONSOLE_PREFIX,
  BATCH_FAILURE_RECORD_TAG,
  BATCH_FAILURE_SUMMARY_TAG,
  recordEntityBatchFailure,
  reportEntityBatchFailures,
} from '@/features/modules/entity-batch-report';

/**
 * `entity-batch-report` is the ONE seam a finished batch's failures go
 * through (docs/17 row 131): it raises the console entry AND the toast, so
 * the two surfaces cannot drift. These pins judge the two things the owner
 * asked for and the two things AGENTS forbids losing:
 *
 * - the console payload is the DIAGNOSTIC one — per failure the name, WHICH
 *   of the four paths it came down (`refused` / `interrupted` /
 *   `run-not-completed` / `setup-error`), the run id, the terminal status, the
 *   run's OWN `failureKind` + `errorMessage`, the engine's sentence, and the
 *   RAW value (by identity where the value is handed over untouched);
 * - the toast is the user-visible surface (rule 2 — a `console.error` alone
 *   is forbidden) and it does NOT blink away (rule 2's other half);
 * - the RECORD survives the batch (the owner, verbatim: *"the root problem is
 *   simply not recorded"*): a failure is written down when it HAPPENS (from the
 *   batch's one funnel), and every record exists as a PASTEABLE single-line
 *   JSON string as well as a live object.
 */

const toastErrorMock = vi.mocked(toast.error);

/** The console entry this seam emits, captured with the guard's own wrapper
 * replaced (a spy is not noise — `tests/setup.ts` §Console guard). */
let consoleSpy: MockInstance<(...data: unknown[]) => void>;

beforeEach(() => {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
  vi.clearAllMocks();
});

function campaignFixture(): Campaign {
  return createCampaign({ name: 'Ember Crypt', system: 'dnd5e' });
}

function moduleFixture(campaignId: string): Module {
  const base = createModule({
    campaignId,
    title: 'Ember Crypt',
    concept: 'A crypt guarding an old seal.',
    levelMin: 1,
    levelMax: 4,
    sizeDial: 'standard',
  });
  return moduleSchema.parse({ ...base, parts: [], entityKinds: [], entityNamesNormalized: true });
}

/** The batch's console entries, split into its greppable headline, its payload
 * object and its PASTEABLE summary line. TWO entries, and that is the design:
 * the headline+object pair for reading in devtools, then the single-line JSON
 * the owner copies back. */
function consoleEntry(): {
  headline: string;
  payload: Record<string, unknown>;
  summaryLine: string;
  summary: Record<string, unknown>;
} {
  expect(consoleSpy).toHaveBeenCalledTimes(2);
  const [headline, payload] = consoleSpy.mock.calls[0] as [string, Record<string, unknown>];
  const [summaryLine] = consoleSpy.mock.calls[1] as [string, Record<string, unknown>];
  return { headline, payload, summaryLine, summary: parseTagged(summaryLine, BATCH_FAILURE_SUMMARY_TAG) };
}

/** Reads the JSON out of a tagged record line and FAILS if the line does not
 * carry that tag — the tag is the contract that makes the line greppable. */
function parseTagged(line: string, tag: string): Record<string, unknown> {
  const prefix = `${BATCH_FAILURE_CONSOLE_PREFIX} ${tag} `;
  expect(line.startsWith(prefix)).toBe(true);
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}

interface PayloadFailure {
  name: string;
  kind: string;
  message: string;
  runId: string | null;
  status: string | null;
  failureKind: string | null;
  errorMessage: string | null;
  raw: unknown;
  issues: unknown;
}

function payloadFailures(payload: Record<string, unknown>): PayloadFailure[] {
  return payload.failures as PayloadFailure[];
}

/** A run row as the engine hands it back to the batch. */
function runRow(errorMessage: string, status = 'failed'): PersonaRun {
  return { id: 'run-1', status, errorMessage, failureKind: null } as unknown as PersonaRun;
}

/** A run the page killed: `db/runRepo.failRunningRuns` writes exactly this. */
function interruptedRow(): PersonaRun {
  return {
    id: 'run-7',
    status: 'failed',
    errorMessage: 'Interrupted by reload',
    failureKind: 'cancelled',
  } as unknown as PersonaRun;
}

function contextFixture(): {
  campaign: Campaign;
  module: Module;
  kind: 'npc';
  total: number;
} {
  const campaign = campaignFixture();
  return { campaign, module: moduleFixture(campaign.id), kind: 'npc', total: 10 };
}

function report(failures: EntityBatchFailure[]): {
  campaign: Campaign;
  module: Module;
  kind: 'npc';
  total: number;
  failures: EntityBatchFailure[];
} {
  return { ...contextFixture(), failures };
}

describe('a failure is RECORDED WHEN IT HAPPENS, and the record is pasteable text', () => {
  it('writes the pasteable line as ONE string argument, with the live object beside it', () => {
    recordEntityBatchFailure(contextFixture(), {
      name: 'Kael',
      kind: 'run-not-completed',
      message: 'gateway down',
      runId: 'run-1',
      status: 'failed',
      errorMessage: 'gateway down',
    });

    // TWO entries: the line, then the object. The LINE is a SINGLE string
    // argument on purpose — a console row carrying an extra object argument
    // renders a devtools-specific preview into whatever gets copied, and this
    // line is the thing that gets pasted.
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    expect(consoleSpy.mock.calls[0]).toHaveLength(1);
    expect(consoleSpy.mock.calls[1]).toHaveLength(2);
  });

  it('the pasted line carries every discriminating field AND the batch it belongs to', () => {
    recordEntityBatchFailure(contextFixture(), {
      name: 'Kael',
      kind: 'interrupted',
      message: 'Interrupted by reload',
      runId: 'run-7',
      status: 'failed',
      failureKind: 'cancelled',
      errorMessage: 'Interrupted by reload',
    });

    const [line] = consoleSpy.mock.calls[0] as [string];
    const record = parseTagged(line, BATCH_FAILURE_RECORD_TAG);
    // Which entity, which path, which run, what the run itself said — the
    // fields that were missing when the owner had only a four-second sentence.
    expect(record.name).toBe('Kael');
    expect(record.kind).toBe('interrupted');
    expect(record.message).toBe('Interrupted by reload');
    expect(record.runId).toBe('run-7');
    expect(record.status).toBe('failed');
    expect(record.failureKind).toBe('cancelled');
    expect(record.errorMessage).toBe('Interrupted by reload');
    // Self-contained: the module, the campaign, the kind and the batch size
    // ride the same line, so a pasted record needs no second lookup.
    const module = record.module as { title: string };
    const campaign = record.campaign as { name: string };
    expect(module.title).toBe('Ember Crypt');
    expect(campaign.name).toBe('Ember Crypt');
    // `batchKind` is the BATCH's kind and `kind` is the FAILURE's class — two
    // facts, two keys (they collided under one name before this pin existed).
    expect(record.batchKind).toBe('npc');
    expect(record.total).toBe(10);
    // …and the live object carries the SAME record, so the text and the
    // devtools view can never disagree.
    const [, structured] = consoleSpy.mock.calls[1] as [string, Record<string, unknown>];
    expect(record).toEqual(structured);
  });

  it('the batch summary line and the summary object carry the same fields', () => {
    const run = runRow('gateway down');
    reportEntityBatchFailures(
      report([
        { name: 'Kael', kind: 'run-not-completed', message: 'gateway down', runId: 'run-1', status: 'failed', errorMessage: 'gateway down', raw: run },
        { name: 'Bram', kind: 'refused', message: 'a designed stop', runId: 'run-2', status: 'completed' },
      ]),
    );

    const { payload, summary } = consoleEntry();
    // One source of truth, two renderings: the pasteable line is produced from
    // the very object the console shows, so no field can exist in one and not
    // the other.
    expect(summary).toEqual(payload);
    expect(summary.failed).toBe(2);
    expect(summary.total).toBe(10);
  });

  it('a value that cannot be serialized does not swallow the record (nor the batch)', () => {
    recordEntityBatchFailure(contextFixture(), {
      name: 'Kael',
      kind: 'setup-error',
      message: 'odd value',
      raw: 1n,
    });

    const [line] = consoleSpy.mock.calls[0] as [string];
    // MEASURED: `JSON.stringify` THROWS on a BigInt (and on a cycle). Throwing
    // here would abort the batch — a reporting failure is not a generation
    // failure — and printing nothing would lose the evidence the owner asked
    // for, so the line SAYS it could not be serialized (rule 1: no silent
    // fallback).
    const record = parseTagged(line, BATCH_FAILURE_RECORD_TAG);
    expect(record.unserializable).toBe(true);
    expect(String(record.reason)).toContain('BigInt');
    // The live object still carries the value itself.
    const [, structured] = consoleSpy.mock.calls[1] as [string, Record<string, unknown>];
    expect(structured.name).toBe('Kael');
    expect(structured.raw).toBe(1n);
  });
});

describe('the console entry is the diagnostic payload the owner asked for', () => {
  it('is TWO entries per batch — the headline+payload, then the pasteable line', () => {
    const campaign = campaignFixture();
    const module = moduleFixture(campaign.id);
    const run = runRow('gateway down');
    reportEntityBatchFailures({
      campaign,
      module,
      kind: 'npc',
      total: 10,
      failures: [
        { name: 'Kael', kind: 'run-not-completed', message: 'gateway down', runId: 'run-1', status: 'failed', raw: run },
      ],
    });

    const { headline, payload } = consoleEntry();
    // The prefix is what makes the entry findable in a console full of noise.
    expect(headline).toBe(`${BATCH_FAILURE_CONSOLE_PREFIX} npc batch: 1 of 10 failed`);
    expect(payload.campaign).toEqual({ id: campaign.id, name: 'Ember Crypt' });
    expect(payload.module).toEqual({ id: module.id, title: 'Ember Crypt' });
    expect(payload.batchKind).toBe('npc');
    expect(payload.total).toBe(10);
    expect(payload.failed).toBe(1);
    expect(payload.refused).toBe(0);
    // EVERY class counter is pinned, not just the two the copy states: an
    // aggregate the payload carries but nothing asserts is a field a future
    // edit can wire to the wrong bucket unnoticed (measured: this line was the
    // one line of the change NO pin reached until this assertion existed).
    expect(payload['run-not-completed']).toBe(1);
    expect(payload['setup-error']).toBe(0);
    expect(payload.interrupted).toBe(0);
    expect(payloadFailures(payload)).toHaveLength(1);
  });

  it('carries, per failure, the name, WHICH path, the run id, the terminal status and the raw value', () => {
    const run = runRow('Step "draft" rejected: the model reply could not be parsed.');
    reportEntityBatchFailures(
      report([
        {
          name: 'Kael',
          kind: 'run-not-completed',
          message: 'Step "draft" rejected: the model reply could not be parsed.',
          runId: 'run-1',
          status: 'failed',
          errorMessage: 'Step "draft" rejected: the model reply could not be parsed.',
          raw: run,
        },
      ]),
    );

    const [failure] = payloadFailures(consoleEntry().payload);
    expect(failure?.name).toBe('Kael');
    expect(failure?.kind).toBe('run-not-completed');
    expect(failure?.message).toBe('Step "draft" rejected: the model reply could not be parsed.');
    expect(failure?.runId).toBe('run-1');
    expect(failure?.status).toBe('failed');
    // The run's OWN classification and errorMessage ride beside the status.
    expect(failure?.failureKind).toBeNull();
    expect(failure?.errorMessage).toBe('Step "draft" rejected: the model reply could not be parsed.');
    // The RAW row, by IDENTITY: a value the site hands over untouched must
    // arrive as the same object, which a deep-equality pin could not tell
    // apart from a re-built copy.
    expect(failure?.raw).toBe(run);
  });

  it('separates a PAGE RELOAD from a broken generator: it carries the run’s own failureKind and errorMessage', () => {
    const run = interruptedRow();
    reportEntityBatchFailures(
      report([
        {
          name: 'Kael',
          kind: 'interrupted',
          message: 'Interrupted by reload',
          runId: 'run-7',
          status: 'failed',
          failureKind: 'cancelled',
          errorMessage: 'Interrupted by reload',
          raw: run,
        },
      ]),
    );

    const { headline, payload } = consoleEntry();
    // The headline names the class without expanding anything: this is a
    // reloaded page, not a broken generator.
    expect(headline).toBe(`${BATCH_FAILURE_CONSOLE_PREFIX} npc batch: 1 of 10 failed (1 cancelled or interrupted)`);
    expect(payload.interrupted).toBe(1);
    expect(payload.refused).toBe(0);
    const [failure] = payloadFailures(payload);
    expect(failure?.kind).toBe('interrupted');
    // MEASURED: the row says `status: 'failed'` with `failureKind: 'cancelled'`
    // (`db/runRepo.failRunningRuns`) — so the STATUS alone cannot tell the
    // owner whether his generator is broken. These two fields can.
    expect(failure?.status).toBe('failed');
    expect(failure?.failureKind).toBe('cancelled');
    expect(failure?.errorMessage).toBe('Interrupted by reload');
    expect(failure?.raw).toBe(run);
  });

  it('names a designed REFUSAL as a refusal, and carries the run that COMPLETED onto the cast row', () => {
    const destination = {
      id: 'artifact-9',
      kind: 'npc',
      name: 'Zombie',
      data: { creatureRef: { chunkId: '5a4f0c9e-1111-4111-8111-000000000001' } },
    };
    const setupError = new Error('No API key configured');
    reportEntityBatchFailures(
      report([
        {
          name: 'Zombie',
          kind: 'refused',
          message: 'the cast creature «Zombie» is this campaign’s own npc for a library creature',
          runId: 'run-9',
          status: 'completed',
          raw: destination,
        },
        { name: 'Kael', kind: 'setup-error', message: 'No API key configured', raw: setupError },
      ]),
    );

    const { headline, payload } = consoleEntry();
    expect(headline).toBe(
      `${BATCH_FAILURE_CONSOLE_PREFIX} npc batch: 2 of 10 failed (1 refused as designed collisions)`,
    );
    expect(payload.refused).toBe(1);
    expect(payload['setup-error']).toBe(1);
    expect(payload['run-not-completed']).toBe(0);
    expect(payload.interrupted).toBe(0);
    const [refused, setup] = payloadFailures(payload);
    expect(refused?.kind).toBe('refused');
    expect(refused?.runId).toBe('run-9');
    // The refusal's run COMPLETED — the Runs tab shows it as a success, which
    // is exactly why the console has to say what really happened.
    expect(refused?.status).toBe('completed');
    expect(refused?.raw).toBe(destination);
    expect(setup?.kind).toBe('setup-error');
    expect(setup?.raw).toBe(setupError);
    // No run was started, so the fields are honestly ABSENT rather than
    // guessed — `null` so the payload stays copyable as JSON.
    expect(setup?.runId).toBeNull();
    expect(setup?.status).toBeNull();
  });

  it('carries a validation failure’s issues as OBJECTS beside the raw error', () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    if (parsed.success) throw new Error('fixture should fail validation');
    reportEntityBatchFailures(
      report([
        {
          name: 'Kael',
          kind: 'setup-error',
          message: parsed.error.message,
          raw: parsed.error,
        },
      ]),
    );

    const [failure] = payloadFailures(consoleEntry().payload);
    expect(failure?.raw).toBe(parsed.error);
    // The real fields of the real issue — not a shape that any object with an
    // `issues` key would satisfy.
    const issues = failure?.issues as { code: string; path: unknown[]; message: string }[];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('invalid_type');
    expect(issues[0]?.path).toEqual(['name']);
    expect(issues[0]?.message).toContain('expected string');
  });

  it('reports NOTHING at all when the batch has no failures (no console noise, no toast)', () => {
    reportEntityBatchFailures(report([]));
    // The count is the batch's own verdict: an empty list is not a failure
    // report, so neither surface is touched.
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('the toast is the user-visible surface, and it does not blink away', () => {
  it('raises the console entry AND a toast from the SAME call (AGENTS rule 2: never console-only)', () => {
    reportEntityBatchFailures(
      report([
        { name: 'Kael', kind: 'run-not-completed', message: 'gateway down', runId: 'run-1', status: 'failed' },
      ]),
    );

    expect(consoleSpy).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it('is PERSISTENT: the toast carries `duration: Infinity`, never sonner’s 4-second default', () => {
    reportEntityBatchFailures(
      report([
        { name: 'Kael', kind: 'setup-error', message: 'No API key configured' },
      ]),
    );

    // MEASURED: `toastError` passes no duration, so sonner's `TOAST_LIFETIME`
    // (4000 ms) applies and the report disappears in four seconds — the
    // owner's own "vanished quickly". `duration: Infinity` is what
    // `toastErrorPersistent` passes, and it is the only option object here.
    // `closeButton: true` rides the same options object (docs/17 row 136):
    // "nothing may auto-dismiss it" and "the user can dismiss it" are ONE
    // decision — a persistent notice with no dismiss control was PERMANENT.
    const [title, options] = toastErrorMock.mock.calls[0] as [
      string,
      { duration?: number; closeButton?: boolean },
    ];
    expect(title).toContain('1 of 10 npcs');
    expect(options).toEqual({ duration: Infinity, closeButton: true });
  });

  it('keeps the sentence this app has ALWAYS raised for a batch with no refusals', () => {
    reportEntityBatchFailures(
      report([
        { name: 'Kael', kind: 'run-not-completed', message: 'gateway down', runId: 'run-1', status: 'failed' },
        { name: 'Bram', kind: 'run-not-completed', message: 'gateway down', runId: 'run-2', status: 'failed' },
      ]),
    );

    // Byte-identical to the pre-change copy (pinned verbatim in
    // `tests/features/entity-panel.test.tsx`): nothing about a plain generator
    // failure was reworded, and its runs really are in the Runs tab. The
    // options object is asserted EXACTLY, so this also keeps the notice
    // dismissible (`closeButton: true`, docs/17 row 136) and descriptionless.
    expect(toastErrorMock).toHaveBeenCalledWith(
      '2 of 10 npcs failed to generate — see the Runs tab ("Kael" — gateway down; "Bram" — gateway down)',
      { duration: Infinity, closeButton: true },
    );
  });

  it('tells the owner which number is the DESIGNED one, and names the way out for each refusal', () => {
    const refusal =
      'the cast creature «Zombie» is this campaign’s own npc for a library creature — its stats are derived from that creature and its name is the citation’s. Renaming or overwriting it as «Zombie» would stop every encounter and battle that cites the creature from finding it. Edit its prose instead, or make a separate npc of that name.';
    reportEntityBatchFailures(
      report([
        { name: 'Zombie', kind: 'refused', message: refusal, runId: 'run-1', status: 'completed' },
        { name: 'Kael', kind: 'run-not-completed', message: 'gateway down', runId: 'run-2', status: 'failed' },
      ]),
    );

    const [title] = toastErrorMock.mock.calls[0] as [string];
    // The two numbers are SEPARATE, and the designed one is named as designed:
    // counting a refusal as a generation failure is the conflation docs/17
    // row 117 rules out.
    expect(title).toContain('2 of 10 npcs did not generate');
    expect(title).toContain('1 refused as cast-creature collisions (a designed stop, not a generator failure)');
    expect(title).toContain('1 failed to generate — see the Runs tab');
    // Every refusal carries its own way out (the refusal seam's own sentence).
    expect(title).toContain('make a separate npc of that name');
  });

  it('does not present an INTERRUPTION as a generator failure, and names the way out', () => {
    reportEntityBatchFailures(
      report([
        {
          name: 'Kael',
          kind: 'interrupted',
          message: 'Interrupted by reload',
          runId: 'run-7',
          status: 'failed',
          failureKind: 'cancelled',
          errorMessage: 'Interrupted by reload',
        },
      ]),
    );

    const [title] = toastErrorMock.mock.calls[0] as [string];
    // The owner's question is "is my generator broken?" — for a reloaded page
    // the honest answer is no, and it says so in words.
    expect(title).toContain('1 of 10 npcs did not generate');
    expect(title).toContain('1 cancelled or interrupted while they were running');
    expect(title).toContain('not a generator failure, so run the batch again');
    // The reload is not a generator failure, so it is never called one.
    expect(title).not.toContain('failed to generate');
    expect(title).not.toContain('see the Runs tab');
    expect(title).toContain('"Kael" — Interrupted by reload');
  });

  it('does not send the owner to the Runs tab when NOTHING failed to generate', () => {
    reportEntityBatchFailures(
      report([
        { name: 'Zombie', kind: 'refused', message: 'the cast creature «Zombie» is a designed stop', runId: 'run-1', status: 'completed' },
      ]),
    );

    const [title] = toastErrorMock.mock.calls[0] as [string];
    // A refusal's run COMPLETED, so the Runs tab has no failed row for it —
    // pointing there would send the owner looking for a failure that the app
    // never recorded. The class clause is simply absent, rather than a
    // "0 failed to generate" that reads like a number he has to interpret.
    expect(title).toContain('1 of 10 npcs did not generate');
    expect(title).toContain('1 refused as cast-creature collisions');
    expect(title).not.toContain('see the Runs tab');
  });
});
