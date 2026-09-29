import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ADVISOR_LENSES, advisorApprovalText, advisorLens } from '@/domain/advisors';
import { moduleChatMessageSchema } from '@/domain';
import { buildAdvisorMessages } from '@/llm/advisors';
import { serializeChatThread } from '@/features/modules/canvas/chatPersist';

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn(), toastInfo: vi.fn() }));

/** The command-tag vocabulary the WRITER is taught (llm/canvasChat) — an advisor must never see it. */
const COMMAND_VOCABULARY = [
  '<edit', '</edit', '<replace_level', '<append_level', '<request', '<change', '<search', '<replace>',
  'replace_level', 'append_level',
];

describe('advisors (docs/17 row 396)', () => {
  it('the lens list is the single source: unique ids, each resolvable, each prompt free of command vocabulary', () => {
    expect(ADVISOR_LENSES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ADVISOR_LENSES.map((lens) => lens.id)).size).toBe(ADVISOR_LENSES.length);
    for (const lens of ADVISOR_LENSES) {
      expect(advisorLens(lens.id)).toBe(lens);
      for (const tag of COMMAND_VOCABULARY) expect(lens.prompt).not.toContain(tag);
    }
  });

  it('the outgoing advisor messages carry the document, the lens and the chat prose but NONE of the command vocabulary', () => {
    for (const lens of ADVISOR_LENSES) {
      const messages = buildAdvisorMessages(lens, 'DOC-MARKER premise text', [
        { role: 'user', text: 'make the gate scene rainier' },
        { role: 'assistant', text: 'Done, it now rains.' },
      ]);
      const wire = JSON.stringify(messages);
      expect(wire).toContain('DOC-MARKER premise text');
      expect(wire).toContain(lens.prompt.slice(0, 30));
      expect(wire).toContain('make the gate scene rainier');
      for (const tag of COMMAND_VOCABULARY) expect(wire).not.toContain(tag);
    }
  });

  it('the approval turn attributes lens and model and quotes the critique verbatim', () => {
    const text = advisorApprovalText(
      { lensId: 'continuity', lensName: 'Continuity & consistency', model: 'm/x', range: null, state: 'pending' },
      'Line one\nLine two',
    );
    expect(text).toContain('Continuity & consistency');
    expect(text).toContain('m/x');
    expect(text).toContain('> Line one\n> Line two');
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
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    const offenders = walk(join(process.cwd(), 'src')).filter(
      (file) =>
        !file.endsWith(join('domain', 'advisors.ts')) &&
        ADVISOR_LENSES.some((lens) => readFileSync(file, 'utf8').includes(`id: '${lens.id}'`)),
    );
    expect(offenders).toEqual([]);
    // Non-vacuity: the sidebar renders the list, it does not restate it.
    expect(readFileSync(join(process.cwd(), 'src/features/modules/canvas/ChatSidebar.tsx'), 'utf8')).toContain('ADVISOR_LENSES.map');
  });
});
