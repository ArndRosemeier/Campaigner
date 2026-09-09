import { describe, expect, it } from 'vitest';

import { statBlockSchema } from '@/domain';
import {
  assembleImagePrompt,
  buildImagePrompt,
  IMAGE_TEXT_NEGATIVE,
  MOB_PORTRAIT_TEXT_NEGATIVE,
  portraitGroundingForChunk,
} from '@/llm/imagePromptDraft';

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
      negative: IMAGE_TEXT_NEGATIVE,
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
      negative: IMAGE_TEXT_NEGATIVE,
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

describe('portraitGroundingForChunk (stat-exempt mob grounding)', () => {
  // Every numeric/stat field carries a distinctive marker; the prose carries
  // no digits, so any leaked digit string is a field-exclusion failure.
  const STAT_FIXTURE = statBlockSchema.parse({
    system: 'dnd5e',
    level: '13',
    size: 'Huge',
    creatureType: 'dragon',
    ac: 19,
    acNote: 'natural armor',
    hp: 256,
    hpFormula: '19d12 + 133',
    speed: '40 ft., fly 80 ft.',
    abilities: { str: 27, dex: 10, con: 25, int: 16, wis: 13, cha: 21 },
    saves: 'Dex +5, Con +12',
    skills: 'Perception +16, Stealth +5',
    senses: 'blindsight 60 ft., darkvision 120 ft.',
    languages: 'Common, Draconic',
    traits: [
      { name: 'Legendary Resistance', text: 'shrugs off mortal frailty with ancient poise' },
    ],
    actions: [{ name: 'Bite', text: 'a cavernous maw lined with smoke' }],
    reactions: [{ name: 'Tail Sweep', text: 'a lashing tail that scatters embers' }],
    legendary: [{ name: 'Wing Gust', text: 'a storm of ash unfolds from vast wings' }],
    extras: { 'Spell Slots': 'three per day' },
  });
  const RAW_TEXT = 'Ancient Dragon, Huge dragon. HP 256, AC 19, saves Dex +5.';

  it('composes size + creatureType identity plus named-text prose', () => {
    const grounding = portraitGroundingForChunk({ text: RAW_TEXT, statBlock: STAT_FIXTURE });
    expect(grounding).toContain('Huge');
    expect(grounding).toContain('dragon');
    expect(grounding).toContain('Legendary Resistance');
    expect(grounding).toContain('shrugs off mortal frailty with ancient poise');
    expect(grounding).toContain('Bite');
    expect(grounding).toContain('a cavernous maw lined with smoke');
    expect(grounding).toContain('Tail Sweep');
    expect(grounding).toContain('a lashing tail that scatters embers');
    expect(grounding).toContain('Wing Gust');
    expect(grounding).toContain('a storm of ash unfolds from vast wings');
  });

  it('excludes EVERY numeric/stat field (identity + prose in, numbers out)', () => {
    const grounding = portraitGroundingForChunk({ text: RAW_TEXT, statBlock: STAT_FIXTURE });
    // One marker per excluded field: level, ac, acNote, hp, hpFormula,
    // speed, abilities (str), saves, skills, senses, languages, extras,
    // system. Exclusion is by FIELD, not digit-sniffing.
    for (const marker of [
      '13', // level (borderline progression number — deliberately out)
      '19', // ac
      'natural armor', // acNote
      '256', // hp
      '19d12 + 133', // hpFormula
      'fly 80 ft.', // speed
      '27', // abilities.str
      'Dex +5', // saves
      'Perception +16', // skills
      'darkvision 120 ft.', // senses
      'Draconic', // languages (digit-free value: excluded by field)
      'Spell Slots', // extras
      'dnd5e', // system
    ]) {
      expect(grounding, `leaked stat marker: ${marker}`).not.toContain(marker);
    }
    // The raw chunk text (stat digits included) never feeds the grounding.
    expect(grounding).not.toContain(RAW_TEXT);
  });

  it('falls back to chunk.text verbatim when statBlock is null (loud residual risk)', () => {
    // Unparsed chunks have no stat-free material: the raw text — today's
    // behavior, stat digits included — is returned BY EXPLICIT DESIGN.
    expect(portraitGroundingForChunk({ text: RAW_TEXT, statBlock: null })).toBe(RAW_TEXT);
  });

  it('caps the composed grounding deterministically at 800 chars', () => {
    const long = statBlockSchema.parse({
      ...STAT_FIXTURE,
      traits: [{ name: 'Verbose', text: 'y'.repeat(2000) }],
    });
    const first = portraitGroundingForChunk({ text: RAW_TEXT, statBlock: long });
    const second = portraitGroundingForChunk({ text: RAW_TEXT, statBlock: long });
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(800);
  });

  it('carries the mob text-render negative into the draft and the Avoid line', () => {
    const draft = buildImagePrompt(
      {
        name: 'Ancient Dragon',
        kind: 'npc',
        summary: '',
        body: portraitGroundingForChunk({ text: RAW_TEXT, statBlock: STAT_FIXTURE }),
        data: null,
      },
      { systemLabel: 'D&D 5e', negative: MOB_PORTRAIT_TEXT_NEGATIVE },
    );
    expect(draft.negative).toBe(IMAGE_TEXT_NEGATIVE);
    const final = assembleImagePrompt(draft);
    expect(final).toContain('Avoid: text, letters, numbers');
    expect(final).toContain('shrugs off mortal frailty');
    expect(final).not.toContain('256');
  });

  it('keeps the appearance shortcut winning while carrying the negative', () => {
    const draft = buildImagePrompt(
      {
        name: 'Grix',
        kind: 'npc',
        summary: '',
        body: 'unused',
        data: { appearance: 'Small, soot-stained, goggles.' },
      },
      { systemLabel: 'D&D 5e', negative: MOB_PORTRAIT_TEXT_NEGATIVE },
    );
    expect(draft.prompt).toBe('D&D 5e=>Small, soot-stained, goggles.');
    expect(draft.negative).toBe(MOB_PORTRAIT_TEXT_NEGATIVE);
  });

  it('defaults the negative to the shared text-render guard (default-on, both branches)', () => {
    const grounded = buildImagePrompt(
      { name: 'Bare', kind: 'note', summary: 's', body: '', data: null },
      { systemLabel: 'D&D 5e' },
    );
    expect(grounded.negative).toBe(IMAGE_TEXT_NEGATIVE);
    const shortcut = buildImagePrompt(
      { name: 'Grix', kind: 'npc', summary: '', body: '', data: { appearance: 'Tall and gaunt.' } },
      { systemLabel: 'D&D 5e' },
    );
    expect(shortcut.negative).toBe(IMAGE_TEXT_NEGATIVE);
    expect(assembleImagePrompt(shortcut)).toContain('Avoid: text, letters, numbers');
  });

  it('keeps the negative option as the explicit-override seam (explicit \'\' opts out)', () => {
    const custom = buildImagePrompt(
      { name: 'Bare', kind: 'note', summary: 's', body: '', data: null },
      { systemLabel: 'D&D 5e', negative: 'custom avoid' },
    );
    expect(custom.negative).toBe('custom avoid');
    const optedOut = buildImagePrompt(
      { name: 'Bare', kind: 'note', summary: 's', body: '', data: null },
      { systemLabel: 'D&D 5e', negative: '' },
    );
    expect(optedOut.negative).toBe('');
    expect(assembleImagePrompt(optedOut)).not.toContain('Avoid:');
  });
});
