import 'fake-indexeddb/auto';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { db } from '@/db/db';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { WritersRoom } from '@/features/campaign/components/writers-room';
import { seedBuiltInPersonas } from '@/db/seed';
import { clearDatabase } from '../db/helpers';

/**
 * Module forge UI (M3): the Writers' room forge card plans and runs the whole
 * module from a concept — with the LLM mocked, end to end through the UI.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const ARC = {
  name: 'The Sunken Shrine',
  summary: 'A drowned shrine calls.',
  suggestedTags: [],
  body: '# The Sunken Shrine',
  arcType: 'mystery',
  premise: 'The bell calls.',
  stakes: 'The town.',
  beats: [{ title: 'First ring', description: 'Docks go quiet.' }],
  hooks: ['A diver vanished.'],
  climax: 'Silence the bell.',
};
const SESSION = {
  name: 'Session 1',
  summary: 'The descent.',
  suggestedTags: [],
  body: '# S1',
  sessionNumber: '1',
  recap: '',
  prep: ['Read arc.'],
  openThreads: [],
};
const LOCATION = {
  name: 'Drowned Docks',
  summary: 'Flooded piers.',
  suggestedTags: [],
  body: '# Docks',
  locationType: 'district',
  inhabitants: 'Fishers',
  pointsOfInterest: [],
  hooks: [],
};
const FACTION = {
  name: 'The Tidal Court',
  summary: 'Rules the harbour.',
  suggestedTags: [],
  body: '# Tidal Court',
  goals: 'Own the drowned shrine.',
  methods: 'Bribes and tides.',
  resources: 'Fishing fleet.',
  ranks: [{ title: 'Harbourmaster', description: 'Speaks for the court.' }],
};
const ENCOUNTER = {
  name: 'Ambush at the Pier',
  summary: 'Cultists attack.',
  suggestedTags: [],
  body: '# Ambush',
  difficulty: 'medium',
  levelHint: 'Level 3',
  monsters: [{ name: 'Cultist', count: 4, notes: 'Netters.' }],
  terrain: 'Wet planks, low tide pools.',
  tactics: 'Surround, drag under.',
  treasure: 'A silver bell charm.',
};
const NPC = {
  name: 'Bell-Keeper Oro',
  summary: 'The last keeper.',
  suggestedTags: [],
  body: '# Oro',
  role: 'Antagonist',
  appearance: 'Salt-crusted.',
  personality: 'Obsessive.',
  motivation: 'Ring the bell thrice.',
  secrets: 'He IS the diver.',
  voiceNotes: '',
  statBlock: null,
};
const STATBLOCK = {
  system: 'dnd5e',
  level: '4',
  size: 'Medium',
  creatureType: 'humanoid (human)',
  ac: 13,
  acNote: 'robes',
  hp: 30,
  hpFormula: '5d8 + 8',
  speed: '30 ft.',
  abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 9, cha: 17 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common',
  extras: { cr: '2' },
};
const REPORT_CONSISTENT = { verdict: 'consistent', summary: 'All good.', issues: [] };

/** Returns the right draft JSON for whatever forge step is calling. */
function forgeReply(messages: unknown): string {
  const text = JSON.stringify(messages);
  // Anchor on the forge briefs (unique per step) — never on digest words.
  if (text.includes('"ac": number')) return JSON.stringify(STATBLOCK);
  if (text.includes('Design the central plot arc')) return JSON.stringify(ARC);
  if (text.includes('Plan session')) return JSON.stringify(SESSION);
  if (text.includes('Create key location')) return JSON.stringify(LOCATION);
  if (text.includes('Create faction')) return JSON.stringify(FACTION);
  if (text.includes('Create key NPC')) return JSON.stringify(NPC);
  if (text.includes('Design combat encounter')) return JSON.stringify(ENCOUNTER);
  if (text.includes('Artifact under review')) return JSON.stringify(REPORT_CONSISTENT);
  return JSON.stringify({ name: 'Unexpected', summary: '', suggestedTags: [], body: '' });
}

beforeEach(async () => {
  await clearDatabase();
  await seedBuiltInPersonas();
});
afterEach(() => {
  cleanup();
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe('Module forge UI', () => {
  it('runs the whole module from a concept and reports completion', async () => {
    const user = userEvent.setup();
    const campaign = await createCampaign({ name: 'Ember', system: 'dnd5e' });

    chatMock.mockImplementation(async (messages: unknown) => forgeReply(messages));

    render(<WritersRoom campaign={campaign} />);
    const forge = await screen.findByTestId('module-forge');

    // Disabled without a concept
    const forgeButton = within(forge).getByTestId('forge-module');
    expect(forgeButton.hasAttribute('disabled')).toBe(true);

    await user.type(
      within(forge).getByLabelText('Module concept'),
      'A drowned shrine calls a harbour town.',
    );
    await user.click(within(forge).getByTestId('forge-module'));

    await waitFor(
      () => {
        expect(screen.getByTestId('forge-status').textContent).toContain('Module complete');
      },
      { timeout: 20000 },
    );

    const artifacts = await listArtifactsByCampaign(campaign.id);
    const names = artifacts.map((artifact) => artifact.name);
    // Defaults: 1 arc + 1 session + 2 locations + 1 faction + 3 NPCs
    // + 2 encounters + 1 continuity report.
    expect(names).toContain('The Sunken Shrine');
    expect(names).toContain('Session 1');
    expect(names).toContain('Drowned Docks');
    expect(names).toContain('The Tidal Court');
    expect(names).toContain('Bell-Keeper Oro');
    expect(names).toContain('Ambush at the Pier');
    // Consistent verdict → no refinement artifacts beyond the report.
    expect(names.filter((name) => name.startsWith('Continuity report'))).toHaveLength(1);
    expect(artifacts).toHaveLength(11);
    const runs = await db.runs.toArray();
    expect(runs).toHaveLength(11);
    for (const run of runs) {
      expect(run.status).toBe('completed');
    }
  }, 30000);
});
