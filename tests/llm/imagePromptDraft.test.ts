import { describe, expect, it } from 'vitest';

import { assembleImagePrompt, buildImagePrompt } from '@/llm/imagePromptDraft';

/**
 * The deterministic Illustrator prompt contract (owner-directed amendment:
 * the LLM prompt-crafting call is gone). Pure function: same artifact data →
 * same prompt, no chat call anywhere.
 */

describe('buildImagePrompt (deterministic image prompt)', () => {
  it('uses a non-empty appearance verbatim behind the system label — nothing invented', () => {
    const draft = buildImagePrompt(
      {
        name: 'Grix',
        kind: 'npc',
        summary: 'A goblin alchemist boss.',
        body: '# Grix\nShe brews. She throws.',
        data: { appearance: 'Small, soot-stained, goggles.', personality: 'Manic' },
      },
      { systemLabel: 'Pathfinder 2e' },
    );
    expect(draft).toEqual({
      prompt: 'Pathfinder 2e=>Small, soot-stained, goggles.',
      negative: '',
      styleNotes: '',
    });
  });

  it('appends the run extra instruction to the appearance shortcut', () => {
    const draft = buildImagePrompt(
      { name: 'Grix', kind: 'npc', summary: '', body: '', data: { appearance: 'Tall and gaunt.' } },
      { systemLabel: 'D&D 5e', extraInstruction: 'Make the lighting moody' },
    );
    expect(draft.prompt).toBe('D&D 5e=>Tall and gaunt.\nMake the lighting moody');
  });

  it('grounds on name/kind/summary/body (markdown stripped) when there is no appearance', () => {
    const draft = buildImagePrompt(
      {
        name: 'The Lighthouse',
        kind: 'location',
        summary: 'A storm-lashed beacon on a black cliff.',
        body: '# The Lighthouse\n**Black cliffs**, gulls and a [storm](https://example.com).',
        data: {},
      },
      { systemLabel: 'D&D 5e' },
    );
    expect(draft).toEqual({
      prompt: [
        'A D&D 5e illustration of The Lighthouse (location).',
        'Summary: A storm-lashed beacon on a black cliff.',
        'Description: The Lighthouse\nBlack cliffs, gulls and a storm.',
      ].join('\n'),
      negative: '',
      styleNotes: '',
    });
  });

  it('is deterministic: the same input builds the same prompt', () => {
    const target = {
      name: 'Goblin Boss',
      kind: 'npc',
      summary: '',
      body: 'Goblin Boss, humanoid, agile commander. HP 21, AC 17.',
      data: { appearance: '', personality: '', statBlock: null },
    };
    const opts = { systemLabel: 'D&D 5e' };
    expect(buildImagePrompt(target, opts)).toEqual(buildImagePrompt(target, opts));
    expect(buildImagePrompt(target, opts).prompt).toBe(
      [
        'A D&D 5e illustration of Goblin Boss (npc).',
        'Description: Goblin Boss, humanoid, agile commander. HP 21, AC 17.',
      ].join('\n'),
    );
  });

  it('caps the stripped description at 800 characters', () => {
    const draft = buildImagePrompt(
      {
        name: 'Long',
        kind: 'note',
        summary: '',
        body: 'x'.repeat(1000),
        data: null,
      },
      { systemLabel: 'D&D 5e' },
    );
    const description = draft.prompt.split('Description: ')[1] ?? '';
    expect(description).toHaveLength(800);
  });

  it('throws loudly when there is no appearance, summary, or body to ground on', () => {
    // AGENTS rule 1: no placeholder prompt of nothing.
    expect(() =>
      buildImagePrompt(
        { name: 'Bare', kind: 'npc', summary: '', body: '', data: { appearance: '' } },
        { systemLabel: 'D&D 5e' },
      ),
    ).toThrow(/no appearance, summary, or body/);
  });

  it('assembleImagePrompt folds style notes and avoid lists, dropping empty ones', () => {
    expect(assembleImagePrompt({ prompt: 'P', negative: 'N', styleNotes: 'S' })).toBe(
      'P\nStyle: S\nAvoid: N',
    );
    // The deterministic drafts carry no style/negative guidance — nothing is
    // folded in.
    expect(assembleImagePrompt({ prompt: 'P', negative: '', styleNotes: '' })).toBe('P');
  });
});
