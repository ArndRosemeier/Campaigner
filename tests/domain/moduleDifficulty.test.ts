import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import {
  createModule,
  DEFAULT_MODULE_DIFFICULTY,
  difficultyBudgetMultiplier,
  MODULE_DIFFICULTIES,
  MODULE_DIFFICULTY_LABELS,
  MODULE_DIFFICULTY_MULTIPLIERS,
  moduleDifficultySchema,
  resolveModuleDifficulty,
} from '@/domain';
import { getModule, saveModule } from '@/db/moduleRepo';
import { clearDatabase } from '../db/helpers';

/**
 * The module difficulty setting (docs/17 row 190, owner request): ONE
 * persisted, zod-validated five-step value beside the encounter budget policy.
 * This pins the STEPS with the middle one as default, the resolver's legacy
 * reading, the documented multiplier ladder and the row stamping — the sibling
 * of `tests/domain/encounterBudget.test.ts`.
 */

describe('moduleDifficulty', () => {
  it('has exactly five steps, with normal as the middle one', () => {
    expect(moduleDifficultySchema.options).toEqual([
      'much-easier',
      'easier',
      'normal',
      'harder',
      'much-harder',
    ]);
    expect(MODULE_DIFFICULTIES).toHaveLength(5);
    expect(MODULE_DIFFICULTIES[2]).toBe('normal');
    expect(DEFAULT_MODULE_DIFFICULTY).toBe('normal');
  });

  it('labels every step exactly once (the dialog reads this map, never its own copy)', () => {
    expect(Object.keys(MODULE_DIFFICULTY_LABELS).sort()).toEqual([...MODULE_DIFFICULTIES].sort());
    expect(MODULE_DIFFICULTY_LABELS.normal).toBe('Normal');
    expect(MODULE_DIFFICULTY_LABELS['much-harder']).toBe('Much harder');
    expect(MODULE_DIFFICULTY_LABELS['much-easier']).toBe('Much easier');
  });

  it('documents a monotone ladder that is 1× at the middle and halves/doubles at the ends', () => {
    const ladder = MODULE_DIFFICULTIES.map((step) => MODULE_DIFFICULTY_MULTIPLIERS[step]);
    expect(ladder).toEqual([0.5, 0.75, 1, 1.5, 2]);
    for (let index = 1; index < ladder.length; index += 1) {
      const previous = ladder[index - 1];
      const current = ladder[index];
      if (previous === undefined || current === undefined) {
        throw new Error('ladder index out of range');
      }
      expect(current).toBeGreaterThan(previous);
    }
    expect(difficultyBudgetMultiplier('normal')).toBe(1);
    expect(difficultyBudgetMultiplier('much-easier')).toBe(0.5);
    expect(difficultyBudgetMultiplier('much-harder')).toBe(2);
  });

  it('resolves a recorded difficulty verbatim and a legacy/absent one to normal', () => {
    expect(resolveModuleDifficulty({ difficulty: 'much-harder' })).toBe('much-harder');
    expect(resolveModuleDifficulty({ difficulty: 'easier' })).toBe('easier');
    // The legacy row (field absent) and a parse-defaulted null both read as the
    // middle step — today's numbers, byte-identical.
    expect(resolveModuleDifficulty({ difficulty: null })).toBe('normal');
    expect(resolveModuleDifficulty({})).toBe('normal');
    expect(resolveModuleDifficulty(undefined)).toBe('normal');
  });

  it('stamps an explicit choice on the module row and records null when none was made', () => {
    const base = {
      campaignId: '00000000-0000-4000-8000-000000000003',
      title: 'M',
      concept: '',
      levelMin: 1,
      levelMax: 3,
      sizeDial: 'standard' as const,
    };
    const chosen = createModule({ ...base, difficulty: 'much-easier' });
    expect(chosen.difficulty).toBe('much-easier');
    const omitted = createModule(base);
    expect(omitted.difficulty).toBeNull();
    // The resolver still reads the legacy null as the middle step.
    expect(resolveModuleDifficulty(omitted)).toBe('normal');
  });

  it('round-trips through the module repo (parse-on-read, no migration)', async () => {
    await clearDatabase();
    const campaignId = '00000000-0000-4000-8000-000000000004';
    const saved = await saveModule(
      createModule({
        campaignId,
        title: 'M',
        concept: '',
        levelMin: 1,
        levelMax: 3,
        sizeDial: 'standard',
        difficulty: 'harder',
      }),
    );
    const row = await getModule(saved.id);
    expect(row?.difficulty).toBe('harder');
    expect(resolveModuleDifficulty(row)).toBe('harder');
  });
});
