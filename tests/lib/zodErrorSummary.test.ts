import { describe, expect, it } from 'vitest';
import { z, type ZodError } from 'zod';

import {
  humanizeZodIssues,
  zodIssuesOf,
  ZOD_SKEW_MITIGATION,
  ZOD_SUMMARY_MAX_ISSUES,
} from '@/lib/zodErrorSummary';

/**
 * Zod grouping units (error-humanization arc): multi-issue failures read
 * as counted/grouped/capped/mitigating prose — never the raw JSON array.
 * Record names are never invented: zod issues carry only code/path/message
 * (verified here — no input values ride the error), so records are cited
 * by table + index.
 */

const tableSchema = z.object({
  artifacts: z.array(z.object({ name: z.string(), data: z.object({ layout: z.string() }) })),
  battles: z.array(z.object({ id: z.string() })),
  modules: z.array(z.object({ title: z.string() })),
});

function parseBadTables(): ZodError {
  const parsed = tableSchema.safeParse({
    artifacts: [{ name: 'Goblin ambush' }, {}, { name: 7, data: {} }, 42, null],
    battles: [{}, {}],
    modules: [{}],
  });
  if (parsed.success) throw new Error('fixture should fail validation');
  return parsed.error;
}

describe('zodIssuesOf', () => {
  it('accepts real ZodErrors', () => {
    const issues = zodIssuesOf(parseBadTables());
    expect(issues).not.toBeNull();
    if (issues === null) throw new Error('fixture issues missing');
    expect(issues.length).toBeGreaterThan(ZOD_SUMMARY_MAX_ISSUES);
  });

  it('accepts ZodError-shaped aggregates without instanceof', () => {
    const shaped = {
      issues: [{ path: ['artifacts', 2, 'name'], message: 'Required' }],
    };
    expect(zodIssuesOf(shaped)).toEqual([
      { path: ['artifacts', 2, 'name'], message: 'Required' },
    ]);
  });

  it('rejects non-conforming `issues` fields and plain errors', () => {
    expect(zodIssuesOf(new Error('boom'))).toBeNull();
    expect(zodIssuesOf({ issues: 'nope' })).toBeNull();
    expect(zodIssuesOf({ issues: [] })).toBeNull();
    expect(zodIssuesOf({ issues: [{ path: 'artifacts', message: 'x' }] })).toBeNull();
    expect(zodIssuesOf({ issues: [{ path: ['a'], message: 42 }] })).toBeNull();
    expect(zodIssuesOf(null)).toBeNull();
    expect(zodIssuesOf('artifacts[0]: Required')).toBeNull();
  });
});

describe('humanizeZodIssues', () => {
  it('groups multi-issue failures by table with counts, capped, with mitigation', () => {
    const issues = zodIssuesOf(parseBadTables());
    if (issues === null) throw new Error('fixture issues missing');
    const text = humanizeZodIssues(issues);

    // Counted + grouped…
    expect(text).toMatch(/\d+ problems in this file/);
    expect(text).toContain('campaign records');
    expect(text).toContain('battles');
    // …capped (first 3 + "and N more")…
    const firstProblems = text.split('First problems: ')[1] ?? '';
    expect(firstProblems.split('; ')).toHaveLength(ZOD_SUMMARY_MAX_ISSUES);
    expect(text).toMatch(/…and \d+ more — full details in the console\./);
    // …actionable…
    expect(text).toContain(ZOD_SKEW_MITIGATION);
    // …and never the raw JSON wall.
    expect(text).not.toContain('"code"');
    expect(text).not.toContain('invalid_type');
  });

  it('cites records by table + index, never inventing names', () => {
    const issues = zodIssuesOf(parseBadTables());
    if (issues === null) throw new Error('fixture issues missing');
    const text = humanizeZodIssues(issues);
    // The fixture row IS named "Goblin ambush" — that name rides the input
    // rows, not the error, so the summary must not contain it.
    expect(text).not.toContain('Goblin ambush');
    expect(text).toMatch(/artifacts\[\d+\]/);
  });

  it('keeps single-issue failures specific', () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    if (parsed.success) throw new Error('fixture should fail validation');
    const issues = zodIssuesOf(parsed.error);
    if (issues === null) throw new Error('fixture issues missing');
    expect(issues).toHaveLength(1);
    const text = humanizeZodIssues(issues);
    expect(text).toContain('name');
    expect(text).not.toContain('more');
    expect(text).toContain(ZOD_SKEW_MITIGATION);
  });
});
