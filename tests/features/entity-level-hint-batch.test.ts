import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import {
  createModule,
  moduleSchema,
  type Campaign,
  type Module,
  type PersonaRun,
} from '@/domain';
import { runEntityBatch } from '@/features/modules/entity-batch';
import {
  ENTITY_LEVEL_HINT_HIERARCHY,
  ENTITY_LEVEL_HINT_LABEL,
} from '@/llm/promptScaffolding';
import type * as runEngineModule from '@/llm/runEngine';
import { useProgressStore } from '@/lib/progress';
import { clearDatabase } from '../db/helpers';

/**
 * The module author's recorded LEVEL reaches the entity generators as STRUCTURED
 * input, through the one batch seam every entity generation passes (owner
 * request, docs/17 row 197).
 *
 * The brief's own bytes are pinned in `tests/features/persona-request.test.ts`;
 * the stat-block precedence (the hint beating a conflicting `level N` sentence)
 * is pinned through the REAL engine in `tests/llm/runEngine.test.ts`. This file
 * pins the WIRING and the two rules that live at the boundary:
 *
 * - a target whose record carries a hint gets it in the brief AND on the run
 *   input as `entityLevelHint` (not as prose the engine must re-parse);
 * - a target with NO hint is byte-identical to before this field existed;
 * - a hint whose name the module text never mentions is reported LOUDLY and by
 *   name, and never invents an entity.
 *
 * The engine is faked — the brief string and the startRun INPUT are the
 * assertion targets.
 */

const { startRunMock, waitForStatusMock } = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  waitForStatusMock: vi.fn(),
}));

vi.mock('@/llm/runEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof runEngineModule>();
  return {
    isRunWithdrawn: actual.isRunWithdrawn,
    runNotCompletedReason: actual.runNotCompletedReason,
    runEngine: { on: () => () => undefined, startRun: startRunMock },
    waitForRunStatus: waitForStatusMock,
  };
});

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastErrorPersistent: vi.fn(),
}));

const { toastError } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);

const NAME = 'Kael the Grey';
const MENTION = `The gate is watched by [[${NAME}]], a gnome of the old school.`;

/** A run that died on its own — the brief was already sent by then. */
function failedWith(message: string): PersonaRun {
  return {
    status: 'failed',
    resultArtifactId: null,
    errorMessage: message,
    failureKind: null,
  } as unknown as PersonaRun;
}

let consoleSpy: MockInstance<(...data: unknown[]) => void>;

function briefs(): string[] {
  return startRunMock.mock.calls.map((call) => {
    const input = call[0] as { brief?: unknown };
    return typeof input.brief === 'string' ? input.brief : '';
  });
}

function runInputs(): { entityLevelHint?: unknown }[] {
  return startRunMock.mock.calls.map((call) => call[0] as { entityLevelHint?: unknown });
}

async function seedModule(levelHint: number | undefined): Promise<{ campaign: Campaign; module: Module }> {
  const campaign = await createCampaign({ name: 'Harbor Campaign', system: 'dnd5e' });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself.',
    levelMin: 1,
    levelMax: 1,
    tone: '',
    sizeDial: 'standard',
  });
  const module = await saveModule(
    moduleSchema.parse({
      ...draft,
      entityKinds: [
        {
          name: NAME,
          kind: 'npc',
          absorbed: [],
          ...(levelHint === undefined ? {} : { levelHint }),
        },
        { name: 'The Old Pier', kind: 'npc', absorbed: [] },
      ],
      spine: {
        premise: `The bell rings over [[${NAME}]].`,
        themes: [],
        partPlan: [{ title: 'One', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
        writerModel: '',
        origin: null,
      },
      parts: [
        {
          planIndex: 0,
          markdown: MENTION,
          status: 'ready',
          errorMessage: '',
          edited: false,
          writerModel: '',
          origin: null,
        },
      ],
    }),
  );
  await seedBuiltInPersonas();
  return { campaign, module };
}

beforeEach(async () => {
  await clearDatabase();
  useProgressStore.getState().reset();
  startRunMock.mockReset();
  waitForStatusMock.mockReset();
  toastErrorMock.mockClear();
  startRunMock.mockResolvedValue('run-1');
  waitForStatusMock.mockResolvedValue(failedWith('the faked run died'));
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('the batch threads the recorded level to the generator as STRUCTURED input', () => {
  it('a target whose record carries a hint gets the paragraph AND the run input field', async () => {
    const { campaign, module } = await seedModule(7);
    await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: NAME }],
    });
    const brief = briefs()[0] ?? '';
    expect(brief).toContain(`${ENTITY_LEVEL_HINT_LABEL}7.${ENTITY_LEVEL_HINT_HIERARCHY}`);
    // STRUCTURED, not prose the engine re-parses: the number rides the run input
    // (what `runStatblock` reads explicitly).
    expect(runInputs()[0]?.entityLevelHint).toBe(7);
  });

  it('is read per ENTITY: the neighbour with no hint gets NO field and NO paragraph', async () => {
    const { campaign, module } = await seedModule(7);
    await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: NAME }, { name: 'The Old Pier' }],
    });
    const [first] = runInputs();
    expect(first?.entityLevelHint).toBe(7);
    // OMITTED — not `null`, not `undefined` spelled explicitly — so the no-hint
    // run input is byte-identical to the pre-field one.
    for (const input of runInputs().slice(1)) {
      expect(input).not.toHaveProperty('entityLevelHint');
    }
    expect(briefs()[1] ?? '').not.toContain(ENTITY_LEVEL_HINT_LABEL);
  });
});

describe('COMPATIBILITY: a module with no hints is byte-identical to before the field', () => {
  it('no hint anywhere ⇒ no paragraph, no run-input field, on every target', async () => {
    const { campaign, module } = await seedModule(undefined);
    await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: NAME }, { name: 'The Old Pier' }],
    });
    for (const brief of briefs()) {
      expect(brief).not.toContain(ENTITY_LEVEL_HINT_LABEL);
      expect(brief).not.toContain(ENTITY_LEVEL_HINT_HIERARCHY);
    }
    for (const input of runInputs()) {
      expect(input).not.toHaveProperty('entityLevelHint');
    }
  });
});

describe('a hint whose name the module text never mentions is a LOUD named issue', () => {
  it('reports the recording name and level, and never invents an entity for it', async () => {
    const { campaign, module } = await seedModule(7);
    // Orphan the hint: the module's own text no longer mentions the name.
    const spine = module.spine;
    const part = module.parts[0];
    if (spine === null || part === undefined) throw new Error('the fixture module lost its text');
    const orphaned = moduleSchema.parse({
      ...module,
      spine: { ...spine, premise: 'The bell rings over the water.' },
      parts: [{ ...part, markdown: 'The pier is empty at dusk.' }],
    });
    await runEntityBatch({
      module: orphaned,
      campaign,
      kind: 'npc',
      targets: [{ name: 'The Old Pier' }],
    });

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    const [title, error] = toastErrorMock.mock.calls[0] ?? [];
    expect(String(title)).toContain('Entity level hint names nothing in the module text');
    expect((error as Error).message).toContain(NAME);
    expect((error as Error).message).toContain('level 7');
    // NEVER a reason to invent an entity: the orphaned name was not generated.
    expect(briefs().some((brief) => brief.includes(NAME))).toBe(false);
    // The console payload keeps the pasteable record (AGENTS rule 2).
    expect(consoleSpy.mock.calls.some((call) => String(call[0]).includes('entity level hint unmatched'))).toBe(true);
  });

  it('says nothing when every hint is mentioned (no noise on a healthy module)', async () => {
    const { campaign, module } = await seedModule(7);
    await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: NAME }],
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
