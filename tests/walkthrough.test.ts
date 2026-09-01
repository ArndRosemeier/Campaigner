import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getArtifact, updateArtifact } from '@/db/artifactRepo';
import { createPersona, type Id } from '@/domain';
import { runEngine } from '@/llm/runEngine';
import { getRun } from '@/db/runRepo';
import { searchRules } from '@/search';
import { clearDatabase } from './db/helpers';

import { waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T8 full walkthrough (06-MILESTONES.md): new campaign → import book →
 * search → pin → NPC Smith manual run → edit artifact → "reload" → intact.
 * Exercises the real repos/pipeline/search/engine (chat mocked) end to end.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const DRAFT = {
  name: 'Goblin Boss',
  summary: 'The grappling goblin from the rulebook.',
  suggestedTags: ['goblin', 'boss'],
  body: '# Goblin Boss\nUses grapples.',
  role: 'Boss',
  appearance: 'Soot-stained',
  personality: 'Cruel',
  motivation: 'Territory',
  secrets: 'None',
  voiceNotes: 'Snarls',
  needsStatBlock: true,
};

const STATBLOCK = {
  system: 'dnd5e',
  level: '2',
  size: 'Small',
  creatureType: 'humanoid (goblinoid)',
  ac: 17,
  acNote: 'chain shirt',
  hp: 66,
  hpFormula: '12d6 + 12',
  speed: '30 ft.',
  abilities: { str: 14, dex: 14, con: 12, int: 10, wis: 8, cha: 10 },
  saves: '',
  skills: '',
  senses: '',
  languages: 'Common, Goblin',
  traits: [],
  actions: [],
  reactions: [],
  legendary: [],
  extras: { CR: '2' },
};

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
});

/** The committed 2-page PDF fixture as a File for ingestion. */
function fixtureFile(): File {
  const fixturePath = join(import.meta.dirname, 'fixtures', 'sample-rulebook.pdf');
  const bytes = readFileSync(fixturePath);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new File([buffer], 'sample-rulebook.pdf', { type: 'application/pdf' });
}

describe('T8 walkthrough', () => {
  it('campaign → import → search → pin → manual run → edit → survives reload', async () => {
    // 1. New campaign.
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });

    // 2. Import the fixture rulebook (real pipeline).
    const { ingestPdf } = await import('@/ingest/ingestFiles');
    const bookResult = await ingestPdf(fixtureFile(), 'dnd5e');
    expect(bookResult.book.status).toBe('ready');
    expect(bookResult.chunkCount).toBeGreaterThan(0);

    // 3. Search finds the goblin boss stat block.
    const hits = await searchRules('Goblin Boss armor class hit points', {
      bookIds: [bookResult.book.id],
    });
    expect(hits.length).toBeGreaterThan(0);
    const goblinHit = hits.find((hit) => hit.chunk.headingPath.includes('Goblin Boss'));
    expect(goblinHit).toBeDefined();
    if (goblinHit === undefined) throw new Error('goblin hit not found');

    // 4. Pin that chunk for the run.
    const pinnedIds = [goblinHit.chunk.id];

    // 5. NPC Smith manual run (persona like the seeded built-in).
    const persona = createPersona({
      slug: 'npc-smith',
      name: 'NPC Smith',
      description: '',
      systemPrompt: 'You are NPC Smith.',
      producesKind: 'npc',
      builtIn: true,
    });
    chatMock
      .mockResolvedValueOnce(JSON.stringify(DRAFT))
      .mockResolvedValueOnce(JSON.stringify(STATBLOCK));

    const runId = await runEngine.startRun({
      campaign,
      persona,
      autonomy: 'manual',
      brief: 'a goblin boss for level 2',
      pinnedChunkIds: pinnedIds,
    });
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    let run = await getRun(runId);
    expect(run?.steps[0]?.name).toBe('retrieve');
    const retrieveOutput = run?.steps[0]?.output as { chunkIds: Id[] };
    const pinnedId = pinnedIds[0];
    if (pinnedId === undefined) throw new Error('no pinned id');
    expect(retrieveOutput.chunkIds).toContain(pinnedId);

    await runEngine.approve(runId, {
      campaign,
      persona,
      autonomy: 'manual',
      brief: '',
      pinnedChunkIds: [],
    });
    await waitFor(async () => {
      run = await getRun(runId);
      expect(run?.steps).toHaveLength(3);
    });
    await runEngine.approve(runId, {
      campaign,
      persona,
      autonomy: 'manual',
      brief: '',
      pinnedChunkIds: [],
    });
    await waitFor(async () => {
      run = await getRun(runId);
      expect(run?.status).toBe('completed');
    });

    // 6. The artifact exists with the parsed stat block; edit it.
    const artifactId = run?.resultArtifactId;
    if (artifactId === null || artifactId === undefined) throw new Error('no artifact');
    const before = await getArtifact(artifactId);
    expect(before?.kind).toBe('npc');
    expect(before?.currentRevision).toBe(1);
    if (before?.kind === 'npc') {
      expect(before.data.statBlock?.ac).toBe(17);
    }

    await updateArtifact(artifactId, { name: 'Skrag the Goblin Boss' });
    const edited = await getArtifact(artifactId);
    expect(edited?.name).toBe('Skrag the Goblin Boss');
    expect(edited?.currentRevision).toBe(2);

    // 7. "Reload": a fresh pass over the same database sees everything.
    const campaignsAfter = await (await import('@/db/campaignRepo')).listCampaigns();
    expect(campaignsAfter.map((row) => row.id)).toContain(campaign.id);
    const artifactAfterReload = await getArtifact(artifactId);
    expect(artifactAfterReload?.name).toBe('Skrag the Goblin Boss');
    expect(chatMock).toHaveBeenCalledTimes(2);
  }, 30000);
});
