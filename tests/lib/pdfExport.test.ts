import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { createArtifact, newId } from '@/domain';
import {
  buildGmNotesDefinition,
  buildPlayerHandoutDefinition,
  exportArtifactPdf,
  markdownToText,
  pdfFileName,
} from '@/lib/pdfExport';

/**
 * PDF export (06-MILESTONES M2): GM notes + player handout templates. The
 * definition builders are asserted as content; one test generates a real PDF
 * blob through pdfmake.
 */

const NPC = {
  campaignId: newId(),
  kind: 'npc' as const,
  name: 'Grimm',
  tags: ['goblin', 'boss'],
  summary: 'A goblin boss with a temper.',
  body: '# Grimm\n\nHe **grapples** first.\n- line one\n- line two',
  data: {
    appearance: 'Soot-stained',
    personality: 'Cruel',
    statBlock: {
      system: 'dnd5e' as const,
      level: '2',
      size: 'Small',
      creatureType: 'humanoid (goblinoid)',
      ac: 17,
      acNote: 'chain shirt',
      hp: 66,
      hpFormula: '12d6 + 22',
      speed: '30 ft.',
      abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 12 },
      saves: '',
      skills: '',
      senses: '',
      languages: 'Common, Goblin',
      traits: [{ name: 'Nimble Escape', text: 'Disengage or hide as a bonus action.' }],
      actions: [],
      reactions: [],
      legendary: [],
      extras: { CR: '2' },
    },
  },
};

function dump(content: unknown): string {
  return JSON.stringify(content);
}

describe('pdf export definitions', () => {
  it('GM notes include structured data and the stat block', () => {
    const artifact = createArtifact({ ...NPC });
    const doc = buildGmNotesDefinition(artifact);
    const text = dump(doc.content);
    expect(text).toContain('Appearance');
    expect(text).toContain('Soot-stained');
    expect(text).toContain('Nimble Escape');
    expect(text).toContain('AC 17');
  });

  it('player handout strips markdown and omits structured data and the stat block', () => {
    const artifact = createArtifact({ ...NPC });
    const doc = buildPlayerHandoutDefinition(artifact);
    const text = dump(doc.content);
    expect(text).toContain('He grapples first.');
    expect(text).toContain('line one');
    expect(text).not.toContain('NPC details');
    expect(text).not.toContain('Soot-stained');
    expect(text).not.toContain('Nimble Escape');
    expect(text).not.toContain('AC 17');
  });

  it('markdownToText strips headings, emphasis, and links', () => {
    const text = markdownToText('# Title\n**bold** and _em_ and [link](https://x.y)');
    expect(text).toBe('Title\nbold and em and link');
  });

  it('generates a real PDF blob for both templates', async () => {
    const artifact = createArtifact({ ...NPC });
    expect(pdfFileName(artifact, 'gm')).toBe('grimm-gm-notes.pdf');

    for (const template of ['gm', 'player'] as const) {
      const blob = await exportArtifactPdf(artifact, template);
      expect(blob.size).toBeGreaterThan(500);
      const head = await blob.slice(0, 5).text();
      expect(head).toBe('%PDF-');
    }
  }, 30000);
});
