import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  ADVISOR_LENSES,
  advisorApprovalText,
  advisorLens,
  customAdvisorSchema,
  visibleAdvisors,
} from '@/domain/advisors';
import {
  advisorScopeUnavailableReason,
  resolveAdvisorTarget,
} from '@/features/modules/canvas/advisorScope';
import { moduleLevelSeparator } from '@/domain/moduleDocument';
import { settingsSchema, defaultSettings } from '@/domain';
import { moduleChatMessageSchema } from '@/domain';
import { buildAdvisorMessages } from '@/llm/advisors';
import { serializeChatThread } from '@/features/modules/canvas/chatPersist';
import { repoFiles } from '../helpers/sourceCode';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

/** The command-tag vocabulary the WRITER is taught (llm/canvasChat) — an advisor must never see it. */
const COMMAND_VOCABULARY = [
  '<edit', '</edit', '<replace_level', '<append_level', '<request', '<change', '<search', '<replace>',
  'replace_level', 'append_level',
];

describe('advisors (docs/17 row 396)', () => {
  it('the lens list is the single source: unique ids, each resolvable, each prompt free of command vocabulary', () => {
    expect(ADVISOR_LENSES.length).toBeGreaterThanOrEqual(9);
    for (const id of ['critique', 'more-details', 'less-details', 'advance-plot', 'next-section', 'tension-pacing', 'continuity', 'agency-stakes', 'encounter-balance']) {
      expect(advisorLens(id)).toBeDefined();
    }
    expect(new Set(ADVISOR_LENSES.map((lens) => lens.id)).size).toBe(ADVISOR_LENSES.length);
    for (const lens of ADVISOR_LENSES) {
      expect(advisorLens(lens.id)).toBe(lens);
      for (const tag of COMMAND_VOCABULARY) expect(lens.instruction).not.toContain(tag);
    }
  });

  it('the outgoing advisor messages carry the document, the lens and the chat prose but NONE of the command vocabulary', () => {
    for (const lens of ADVISOR_LENSES) {
      const messages = buildAdvisorMessages(lens, 'DOC-MARKER premise text', { scope: 'global' }, [
        { role: 'user', text: 'make the gate scene rainier' },
        { role: 'assistant', text: 'Done, it now rains.' },
      ]);
      const wire = JSON.stringify(messages);
      expect(wire).toContain('DOC-MARKER premise text');
      expect(wire).toContain(lens.instruction.slice(0, 30));
      expect(wire).toContain('make the gate scene rainier');
      for (const tag of COMMAND_VOCABULARY) expect(wire).not.toContain(tag);
    }
  });

  it('the approval turn attributes lens and model and quotes the critique verbatim', () => {
    const text = advisorApprovalText(
      { lensId: 'continuity', lensName: 'Continuity & consistency', model: 'm/x', range: null, state: 'pending', scope: { scope: 'selection', level: 2, title: 'The Vault', text: 'Rain hammers\nthe stones.' } },
      'Line one\nLine two',
    );
    expect(text).toContain('Continuity & consistency');
    expect(text).toContain('m/x');
    expect(text).toContain('> Line one\n> Line two');
    expect(text).toContain('level 2');
    expect(text).toContain('> Rain hammers\n> the stones.');
  });

  it('old persisted messages parse byte-unchanged (no advisor key appears), advisor cards round-trip', () => {
    const old = { role: 'user', text: 'hi', raw: null, status: 'ok', error: null, outcomes: [], createdAt: 1 };
    const parsed = moduleChatMessageSchema.parse(old);
    expect(parsed).toEqual(old);
    expect('advisor' in parsed).toBe(false);
    const card = { lensId: 'continuity', lensName: 'C', model: 'm', range: null, state: 'dismissed' as const };
    const round = serializeChatThread([
      { id: 'a', role: 'assistant', text: 'crit', raw: null, status: 'ok', error: null, outcomes: [], createdAt: 2, advisor: card },
      { id: 'b', role: 'user', text: 'hi', raw: null, status: 'ok', error: null, outcomes: [], createdAt: 3 },
    ]);
    expect(round[0]?.advisor).toEqual(card);
    expect('advisor' in (round[1] ?? {})).toBe(false);
    expect(moduleChatMessageSchema.parse(round[0]).advisor?.state).toBe('dismissed');
  });
});

describe('the lens list is the ONE source (source scan)', () => {
  it('no src file but domain/advisors.ts spells a lens id', () => {
    const offenders = repoFiles('src', ['.ts', '.tsx']).filter(
      (file) =>
        !file.endsWith('domain/advisors.ts') &&
        ADVISOR_LENSES.some((lens) => readFileSync(file, 'utf8').includes(`id: '${lens.id}'`)),
    );
    expect(offenders).toEqual([]);
    // Non-vacuity: the sidebar renders the list, it does not restate it.
    expect(readFileSync(join(process.cwd(), 'src/features/modules/canvas/ChatSidebar.tsx'), 'utf8')).toContain('visibleAdvisors(');
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

const DOC = `Premise text here.\n\n${moduleLevelSeparator(1)}\nFirst body.\n\n${moduleLevelSeparator(2)}\nSecond body with a gem.`;
const TITLES = [{ title: 'Gate' }, { title: 'Vault' }];

describe('advisor scopes (docs/17 row 400)', () => {
  it('EVERY scope sends the WHOLE document plus a scope line, and none of the command vocabulary', () => {
    const lens = must(ADVISOR_LENSES[0]);
    const cases = [
      { scope: 'global' as const },
      { scope: 'section' as const, level: 1, title: 'Gate' },
      { scope: 'selection' as const, level: 2, title: 'Vault', text: 'a gem' },
    ];
    for (const target of cases) {
      const wire = JSON.stringify(buildAdvisorMessages(lens, DOC, target, []));
      expect(wire).toContain('Premise text here.');
      expect(wire).toContain('Second body with a gem.');
      for (const tag of COMMAND_VOCABULARY) expect(wire).not.toContain(tag);
    }
    expect(JSON.stringify(buildAdvisorMessages(lens, DOC, must(cases[0]), []))).toContain('Concentrate on the whole document');
    expect(JSON.stringify(buildAdvisorMessages(lens, DOC, must(cases[1]), []))).toContain('the section \\"Gate\\" (level 1)');
    expect(JSON.stringify(buildAdvisorMessages(lens, DOC, must(cases[2]), []))).toContain('> a gem');
  });

  it('selection with nothing selected is unavailable with a reason and resolving it throws (never widens)', () => {
    expect(advisorScopeUnavailableReason('selection', { caret: 3, selection: null })).toMatch(/Select some text/);
    expect(advisorScopeUnavailableReason('selection', { caret: 3, selection: { from: 0, to: 2 } })).toBeNull();
    expect(advisorScopeUnavailableReason('global', { caret: null, selection: null })).toBeNull();
    expect(() => resolveAdvisorTarget('selection', { doc: DOC, caret: 3, selection: null }, TITLES)).toThrow(/Select some text/);
    expect(() => resolveAdvisorTarget('section', { doc: DOC, caret: null, selection: null }, TITLES)).toThrow(/section/);
  });

  it('section scope resolves the caret level, the premise included', () => {
    const at = (needle: string) => DOC.indexOf(needle);
    const level = (offset: number) => {
      const t = resolveAdvisorTarget('section', { doc: DOC, caret: offset, selection: null }, TITLES);
      return t.scope === 'section' ? [t.level, t.title] : null;
    };
    expect(level(2)).toEqual([0, 'Premise']);
    expect(level(at('First'))).toEqual([1, 'Gate']);
    expect(level(at('gem'))).toEqual([2, 'Vault']);
    const sel = resolveAdvisorTarget('selection', { doc: DOC, caret: null, selection: { from: at('a gem'), to: at('a gem') + 5 } }, TITLES);
    expect(sel).toEqual({ scope: 'selection', level: 2, title: 'Vault', text: 'a gem' });
  });

  it('hide and duplicate never mutate the built-ins; custom advisors round-trip settings; empty instruction is refused', () => {
    const before = JSON.stringify(ADVISOR_LENSES);
    const dup = customAdvisorSchema.parse({ id: 'custom-1', name: 'Critique (copy)', instruction: must(advisorLens('critique')).instruction, defaultScope: 'global' });
    const settings = settingsSchema.parse({ ...defaultSettings(), customAdvisors: [dup], hiddenAdvisors: ['critique'] });
    expect(settingsSchema.parse(JSON.parse(JSON.stringify(settings))).customAdvisors).toEqual([dup]);
    const shown = visibleAdvisors(settings.customAdvisors, settings.hiddenAdvisors).map((a) => a.id);
    expect(shown).not.toContain('critique');
    expect(shown).toContain('custom-1');
    expect(shown).toContain('continuity');
    expect(JSON.stringify(ADVISOR_LENSES)).toBe(before);
    expect(() => customAdvisorSchema.parse({ id: 'x', name: 'n', instruction: '   ', defaultScope: 'global' })).toThrow();
    expect(settingsSchema.parse({ ...defaultSettings(), customAdvisors: undefined }).customAdvisors).toEqual([]);
  });
});
