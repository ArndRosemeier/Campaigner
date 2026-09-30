import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
  createModule,
  defaultEncounterBudgetPolicy,
  encounterBudgetPolicySchema,
  resolveEncounterBudgetPolicy,
} from '@/domain';
import { getModule, saveModule } from '@/db/moduleRepo';
import { clearDatabase } from '../db/helpers';

/**
 * The selectable encounter budget policy (docs/17 row 180, owner request):
 * ONE persisted, zod-validated value, resolved once per run. This pins the
 * DEFAULT (sensible per system), the LEGACY reading (a row without the field
 * behaves exactly as today) and the row stamping.
 */

describe('encounterBudgetPolicy', () => {
  it('has exactly three documented values', () => {
    expect(encounterBudgetPolicySchema.options).toEqual(['system', 'pf2e-budget', 'verbatim']);
  });

  it('defaults sensibly per system: pf2e gets a real numeric budget, others keep the band', () => {
    expect(defaultEncounterBudgetPolicy('pathfinder2e')).toBe('pf2e-budget');
    expect(defaultEncounterBudgetPolicy('dnd5e')).toBe('system');
    expect(defaultEncounterBudgetPolicy('cosmere')).toBe('system');
    expect(defaultEncounterBudgetPolicy('generic-d20')).toBe('system');
    expect(defaultEncounterBudgetPolicy('other')).toBe('system');
  });

  it('resolves a recorded policy verbatim and a legacy/absent one to system', () => {
    expect(resolveEncounterBudgetPolicy({ encounterBudgetPolicy: 'verbatim' })).toBe('verbatim');
    expect(resolveEncounterBudgetPolicy({ encounterBudgetPolicy: 'pf2e-budget' })).toBe('pf2e-budget');
    // Legacy row (the field absent) and a parse-defaulted null both read as
    // today's per-system behaviour — never the pf2e default.
    expect(resolveEncounterBudgetPolicy({ encounterBudgetPolicy: null })).toBe('system');
    expect(resolveEncounterBudgetPolicy({})).toBe('system');
    expect(resolveEncounterBudgetPolicy(undefined)).toBe('system');
  });

  it('stamps an explicit choice on the module row and records null when none was made', () => {
    const base = {
      campaignId: '00000000-0000-4000-8000-000000000001',
      title: 'M',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard' as const,
    };
    const chosen = createModule({ ...base, encounterBudgetPolicy: 'pf2e-budget' });
    expect(chosen.encounterBudgetPolicy).toBe('pf2e-budget');
    const omitted = createModule(base);
    expect(omitted.encounterBudgetPolicy).toBeNull();
    // And the resolver still reads the legacy null as today's behaviour.
    expect(resolveEncounterBudgetPolicy(omitted)).toBe('system');
  });

  it('round-trips through the module repo (parse-on-read, no migration)', async () => {
    await clearDatabase();
    const campaignId = '00000000-0000-4000-8000-000000000002';
    const saved = await saveModule(
      createModule({
        campaignId,
        title: 'M',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
        encounterBudgetPolicy: 'verbatim',
      }),
    );
    const row = await getModule(saved.id);
    expect(row?.encounterBudgetPolicy).toBe('verbatim');
    expect(resolveEncounterBudgetPolicy(row)).toBe('verbatim');
  });
});
