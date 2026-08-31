import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import type { Deliverable, OutlineNode } from '@/domain';
import { fullInclude } from '@/domain';
import { createArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { createDeliverable } from '@/db/deliverableRepo';
import { buildModuleDefinition, buildModulePdf } from '@/lib/modulePdf';
import { generatePdfBlob } from '@/lib/pdfExport';
import { statBoxContent } from '@/lib/modulePdf';
import { clearDatabase } from '../db/helpers';

/**
 * Module PDF renderer (07-MILESTONE-3 M3-D): cover + ToC + kicker hierarchy,
 * labeled per-kind sections, stat boxes, player-audience stripping, dangling
 * placeholder, and back-matter galleries. One test generates a real blob.
 */

function statBlockFixture(): Parameters<typeof statBoxContent>[0] {
  return {
    system: 'dnd5e',
    level: '3',
    size: 'Medium',
    creatureType: 'humanoid (cultist)',
    ac: 12,
    acNote: '',
    hp: 9,
    hpFormula: '2d8',
    speed: '30 ft.',
    abilities: { str: 11, dex: 12, con: 10, int: 10, wis: 11, cha: 10 },
    saves: '',
    skills: '',
    senses: '',
    languages: '',
    traits: [{ name: 'Dark Devotion', text: 'Advantage on saves vs. charm.' }],
    actions: [{ name: 'Dagger', text: 'Melee: +3 to hit, 4 damage.' }],
    reactions: [],
    legendary: [],
    extras: {},
  };
}

async function seed(): Promise<{ deliverable: Deliverable; npcId: string; gmNoteId: string }> {
  const campaign = await createCampaign({ name: 'Module Campaign', system: 'dnd5e' });
  const location = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
    body: 'The tower watches the ford.\n\n> The tide waits for no one.',
  });
  const npc = await createArtifact({
    campaignId: campaign.id,
    kind: 'npc',
    name: 'Vexra',
    data: {
      role: 'Antagonist',
      appearance: 'Hooded',
      personality: 'Cold',
      motivation: 'Ritual',
      secrets: 'She fears open water.',
      voiceNotes: 'Whispers',
      statBlock: statBlockFixture(),
    },
  });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    data: {
      difficulty: 'deadly',
      levelHint: '5',
      monsters: [
        { name: 'Cultist', count: 4, notes: 'netters', source: { type: 'inline', statBlock: statBlockFixture() } },
      ],
      terrain: 'wet planks',
      tactics: 'surround and drag under',
      treasure: 'silver bell charm',
    },
    links: [{ targetId: location.id, relation: 'at' }],
  });
  const gmNote = await createArtifact({
    campaignId: campaign.id,
    kind: 'note',
    name: 'GM cheat sheet',
    tags: ['gm-only'],
  });

  const outline: OutlineNode[] = [
    {
      type: 'chapter',
      title: 'Act I',
      children: [
        { type: 'part', title: 'The Dockyards', children: [] },
        { type: 'artifact', artifactId: location.id, include: fullInclude() },
        { type: 'artifact', artifactId: npc.id, include: fullInclude() },
        { type: 'artifact', artifactId: encounter.id, include: fullInclude() },
        { type: 'artifact', artifactId: '00000000-0000-4000-8000-0000000000d1', include: fullInclude() },
        { type: 'text', markdown: 'End of the first act.' },
      ],
    },
    { type: 'gallery', gallery: 'npcs' },
    { type: 'gallery', gallery: 'treasure' },
  ];
  const deliverable = await createDeliverable({
    campaignId: campaign.id,
    title: 'Beneath the Docks',
    subtitle: 'An urban crawl',
    audience: 'gm',
    coverImageId: null,
    outline,
  });
  return { deliverable, npcId: npc.id, gmNoteId: gmNote.id };
}

function textOf(definition: unknown): string {
  return JSON.stringify(definition);
}

describe('buildModuleDefinition', () => {
  beforeEach(clearDatabase);

  it('renders cover, ToC, kickers, sections, galleries, and dangling placeholders (GM)', async () => {
    const { deliverable } = await seed();
    const { db } = await import('@/db/db');
    const campaignArtifacts = await listArtifactsByCampaign((await db.campaigns.toArray())[0]?.id ?? '');
    const definition = buildModuleDefinition(deliverable, campaignArtifacts);
    const text = textOf(definition);

    // Cover + ToC scaffolding.
    expect(text).toContain('Beneath the Docks');
    expect(text).toContain('Compiled with Campaigner');
    expect(text).toContain('"id":"chapters"');
    // Chapter banner + kicker lines.
    expect(text).toContain('ACT I');
    expect(text).toContain('The Dockyards');
    // Labeled sections + read-aloud box.
    expect(text).toContain('Tactics:');
    expect(text).toContain('Secrets:');
    expect(text).toContain('The tide waits for no one.');
    // Stat box + monster count + cross-reference.
    expect(text).toContain('Dark Devotion');
    expect(text).toContain('×4');
    expect(text).toContain('see Old Tower');
    // Back matter.
    expect(text).toContain('NPC Gallery');
    expect(text).toContain('silver bell charm');
    // Dangling artifact node → visible placeholder, not a failure.
    expect(text).toContain('missing artifact');
  });

  it('strips secrets, tactics/treasure, notes, and gm-only artifacts for players', async () => {
    const { deliverable, gmNoteId } = await seed();
    const player: Deliverable = { ...deliverable, audience: 'player' };
    const { db } = await import('@/db/db');
    const campaignArtifacts = await listArtifactsByCampaign((await db.campaigns.toArray())[0]?.id ?? '');
    const text = textOf(buildModuleDefinition(player, campaignArtifacts));

    expect(text).not.toContain('She fears open water');
    expect(text).not.toContain('Tactics:');
    expect(text).not.toContain('surround and drag under');
    expect(text).not.toContain('GM cheat sheet');
    expect(text).not.toContain(gmNoteId);
    // Public prose and read-aloud boxes survive.
    expect(text).toContain('The tower watches the ford.');
    // Treasure LEDGER is back matter and still aggregates encounters.
    expect(text).toContain('silver bell charm');
  });

  it('renders a bordered two-column stat box', () => {
    const box = statBoxContent(statBlockFixture(), 'Cultist');
    const text = textOf(box);
    expect(text).toContain('Cultist');
    expect(text).toContain('DEX 12');
    expect(text).toContain('Melee: +3 to hit');
    const widths = (box as { table?: { widths?: string[] } }).table?.widths;
    expect(widths).toEqual(['*', '*']);
  });

  it('generates a real PDF blob through pdfmake', async () => {
    const { deliverable } = await seed();
    const { db } = await import('@/db/db');
    const campaignArtifacts = await listArtifactsByCampaign((await db.campaigns.toArray())[0]?.id ?? '');
    const blob = await buildModulePdf(deliverable, campaignArtifacts, generatePdfBlob);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(1000);
  });
});
