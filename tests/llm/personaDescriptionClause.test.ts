import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILT_IN_PERSONAS, DETAILS_NOT_STORY_CLAUSE } from '@/llm/personas/builtins';
import { personaBySlug } from '../helpers/builtInPersona';

/**
 * NPC / location / faction descriptions carry DETAIL, not STORY (docs/17 row
 * 365, owner request, verbatim: *"The artefact personas for NPCs and locations
 * and factions and notes should know the context (as they do now) but be
 * instructed to NOT include any story elements in their description. The module
 * text tells the story, the descriptions just provide details, they are not
 * meant to drive the plot (events and encounters are the exception here)."* —
 * scoped by the owner to NPC, location and faction; plot and notes stay story).
 *
 * THE LOAD-BEARING PIN IS THE GOLDEN:
 * `tests/fixtures/personaDescriptions/pre-change-prompts.json` was captured
 * from the tree BEFORE the clause landed, by reading the REAL
 * `BUILT_IN_PERSONAS`. The seven EXEMPT personas must reproduce it byte for
 * byte, and each in-scope persona must reproduce it after REMOVING exactly one
 * clause — so the clause is proven ADDITIVE (nothing existing was dropped,
 * reworded or weakened) and to ride each in-scope prompt exactly once.
 */

const PRE_CHANGE: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(
    join(process.cwd(), 'tests', 'fixtures', 'personaDescriptions', 'pre-change-prompts.json'),
    'utf8',
  ),
) as Readonly<Record<string, string>>;

/**
 * The three kinds whose DESCRIPTIONS are detail, not story (the owner's scope
 * decision: `note` is what the Plot Architect and the Continuity Editor write,
 * and plot/arc/event/encounter content IS the story).
 */
const IN_SCOPE: string[] = ['faction-designer', 'npc-smith', 'worldbuilder'];

/** Everything that must stay byte-identical — including the two `note` writers. */
const EXEMPT: string[] = [
  'arc-weaver',
  'continuity-editor',
  'encounter-cartographer',
  'encounter-smith',
  'event-weaver',
  'illustrator',
  'plot-architect',
];

const promptOf = (slug: string): string => personaBySlug(slug).systemPrompt;

describe('the details-not-story clause rides exactly three personas (docs/17 row 365)', () => {
  it('covers every built-in in the golden — the capture and the personas agree', () => {
    const captured = Object.keys(PRE_CHANGE).sort((a, b) => a.localeCompare(b));
    const builtIn = BUILT_IN_PERSONAS.map((persona) => persona.slug).sort((a, b) =>
      a.localeCompare(b),
    );
    expect(captured).toEqual(builtIn);
  });

  it('is composed by npc-smith, worldbuilder and faction-designer — and by nobody else', () => {
    const carriers = BUILT_IN_PERSONAS.filter((persona) =>
      persona.systemPrompt.includes(DETAILS_NOT_STORY_CLAUSE),
    )
      .map((persona) => persona.slug)
      .sort((a, b) => a.localeCompare(b));
    expect(carriers).toEqual(IN_SCOPE);
  });

  it('rides each in-scope prompt exactly once, immediately before the JSON contract', () => {
    for (const slug of IN_SCOPE) {
      expect(promptOf(slug).split(DETAILS_NOT_STORY_CLAUSE)).toHaveLength(2);
      expect(promptOf(slug)).toContain(
        `${DETAILS_NOT_STORY_CLAUSE}\nAlways answer in the exact JSON format requested.`,
      );
    }
  });

  it('is ADDITIVE: removing it reproduces the pre-change bytes and nothing else moved', () => {
    for (const slug of IN_SCOPE) {
      const withoutClause = promptOf(slug).replace(`${DETAILS_NOT_STORY_CLAUSE}\n`, '');
      expect(withoutClause).toBe(PRE_CHANGE[slug]);
      expect(withoutClause.length).toBeGreaterThan(100);
    }
  });

  it('keeps the grounding/context instruction in all three prompts', () => {
    expect(promptOf('npc-smith')).toContain(
      'You ground all mechanical content (stats, abilities, DCs) in the rules excerpts',
    );
    expect(promptOf('worldbuilder')).toContain('You ground any rules content (hazards,');
    expect(promptOf('worldbuilder')).toContain(
      'in the rules excerpts provided to you, citing book and',
    );
    expect(promptOf('faction-designer')).toContain(
      'you ground any rules content in the rules excerpts provided to you',
    );
    for (const slug of IN_SCOPE) {
      expect(promptOf(slug)).toContain('Always answer in the exact JSON format requested.');
    }
  });
});

describe("the clause states the owner's rule and names the reason (docs/17 row 365)", () => {
  it('is positive-first: the description is DETAIL the GM uses, and says what detail is', () => {
    expect(DETAILS_NOT_STORY_CLAUSE).toContain("You write DETAIL for the GM's table, not STORY.");
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('appearance, manner, facts, relationships, wants');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('and quirks');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('the texture, features and feel of a place');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('the structure, methods,');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('resources and character of a faction');
  });

  it("forbids the story elements, in the owner's own examples", () => {
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('Keep story elements out of');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('your description');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('no scene narration');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('no plot events');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('"the party arrives');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('nothing that advances or resolves the plot');
  });

  it('names the reason: the module text tells the story, and events/encounters carry it', () => {
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('The module text tells the story');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('duplicates the module');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('events and encounters are where story belongs');
  });

  it('keeps the context instruction: use the context, do not recount it', () => {
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('Use the context you are');
    expect(DETAILS_NOT_STORY_CLAUSE).toContain('not to recount what happens');
  });
});

describe('the exempt personas keep their exact prompt bytes (docs/17 row 365)', () => {
  it.each(EXEMPT)('%s is byte-identical to the pre-change capture', (slug) => {
    expect(promptOf(slug)).toBe(PRE_CHANGE[slug]);
    expect(String(PRE_CHANGE[slug]).length).toBeGreaterThan(100);
  });

  it('none of them carries the clause', () => {
    for (const slug of EXEMPT) {
      expect(promptOf(slug)).not.toContain(DETAILS_NOT_STORY_CLAUSE);
    }
  });
});
