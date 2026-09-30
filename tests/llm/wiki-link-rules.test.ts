import { describe, expect, it } from 'vitest';

import { canvasChatSystemPrompt } from '@/llm/canvasChat';
import { WIKI_LINK_WHAT_TO_LINK, WIKI_TOKEN_RULES } from '@/llm/wikiLinkRules';
import { filesWith } from '../helpers/sourceCode';

/**
 * The module chat is told WHAT to link, not only how to spell a link (docs/17
 * row 418). Owner: two capable models linked only encounters and NPCs — "No
 * locations, events or notes" — because the chat's prompt never asked for more.
 */
describe('the wiki-link rules', () => {
  it('the chat prompt asks for locations, factions and events, on both surfaces', () => {
    for (const framing of ['module', 'gm-assist'] as const) {
      const prompt = canvasChatSystemPrompt(framing);
      expect(prompt).toContain(WIKI_LINK_WHAT_TO_LINK);
      expect(prompt).toContain(WIKI_TOKEN_RULES);
    }
    expect(WIKI_LINK_WHAT_TO_LINK).toContain('locations');
    expect(WIKI_LINK_WHAT_TO_LINK).toContain('factions');
    expect(WIKI_LINK_WHAT_TO_LINK).toContain('[[Event Name]]');
  });

  it('each rule is written once in src/', () => {
    expect(filesWith("'- Wiki-link every proper noun")).toEqual(['src/llm/wikiLinkRules.ts']);
    expect(filesWith("'- Wiki-links are [[Name]] tokens")).toEqual(['src/llm/wikiLinkRules.ts']);
  });
});
