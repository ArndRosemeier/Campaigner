import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { chainRunner, type ChainStepInput } from '@/llm/chainRunner';
import {
  buildModuleSteps,
  buildRefineSteps,
  DEFAULT_MODULE_OPTIONS,
  moduleForge,
  parseContinuityReportBody,
} from '@/llm/moduleForge';
import { BUILT_IN_PERSONAS } from '@/llm/personas/builtins';
import { clearDatabase } from '../db/helpers';

/**
 * Module forge (M3): plan building, continuity-report parsing, chain step
 * overrides (per-step autonomy, review target), and the full automatic
 * generate → report → refine flow with a mocked LLM.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
  chainRunner.reset();
  moduleForge.reset();
});

const ARC_DRAFT = {
  name: 'The Drowned Bell',
  summary: 'A sunken shrine drives the town mad.',
  suggestedTags: ['arc'],
  body: '# The Drowned Bell',
  arcType: 'rescue',
  premise: 'The bell calls; the town answers.',
  stakes: 'The town is lost if the bell rings thrice.',
  beats: [
    { title: 'First ringing', description: 'Odd behaviour at the docks.' },
    { title: 'Descent', description: 'The party dives at low tide.' },
  ],
  hooks: ['A diver vanished.'],
  climax: 'Silencing the bell in its shrine.',
};

const REPORT_ISSUES = {
  verdict: 'issues_found',
  summary: 'Two contradictions.',
  issues: [
    {
      severity: 'major',
      message: 'The docks are flooded here but intact elsewhere.',
      relatedTo: 'The Drowned Bell',
    },
  ],
};

describe('buildModuleSteps', () => {
  it('plans arc → sessions → locations → factions → npcs → encounters → review', () => {
    const options = {
      ...DEFAULT_MODULE_OPTIONS,
      concept: 'Smuggling ring in a flooded mining town.',
      refinePass: true,
    };
    const steps = buildModuleSteps(options, BUILT_IN_PERSONAS);

    const slugs = steps.map((step) => {
      const persona = BUILT_IN_PERSONAS.find((candidate) => candidate.id === step.personaId);
      return persona?.slug;
    });
    expect(slugs[0]).toBe('arc-weaver');
    expect(slugs.filter((slug) => slug === 'session-chronicler')).toHaveLength(options.sessions);
    expect(slugs.filter((slug) => slug === 'worldbuilder')).toHaveLength(options.locations);
    expect(slugs.filter((slug) => slug === 'faction-designer')).toHaveLength(options.factions);
    expect(slugs.filter((slug) => slug === 'npc-smith')).toHaveLength(options.npcs);
    expect(slugs.filter((slug) => slug === 'encounter-smith')).toHaveLength(options.encounters);
    expect(slugs[slugs.length - 1]).toBe('continuity-editor');

    // All steps run automatic; briefs carry the concept; review targets first.
    for (const step of steps) {
      expect(step.autonomy).toBe('auto');
    }
    expect(steps[0]?.brief).toContain('flooded mining town');
    expect(steps[steps.length - 1]?.reviewTarget).toBe('first');

    const reviewCount = steps.filter((step) => step.reviewTarget !== undefined).length;
    expect(reviewCount).toBe(1);
  });

  it('omits the review step when refinePass is off', () => {
    const steps = buildModuleSteps(
      { ...DEFAULT_MODULE_OPTIONS, refinePass: false },
      BUILT_IN_PERSONAS,
    );
    const slugs = steps.map((step) => {
      const persona = BUILT_IN_PERSONAS.find((candidate) => candidate.id === step.personaId);
      return persona?.slug;
    });
    expect(slugs).not.toContain('continuity-editor');
  });
});

describe('parseContinuityReportBody', () => {
  it('parses the markdown the run engine writes', () => {
    const body = [
      '# Continuity report — The Drowned Bell',
      '**Verdict:** issues found',
      '- **[major]** The docks are flooded here but intact elsewhere. (relates to: The Drowned Bell)',
      '- **[minor]** A tavern name differs.',
    ].join('\n');
    const report = parseContinuityReportBody(body);
    expect(report.verdict).toBe('issues_found');
    expect(report.issues).toHaveLength(2);
    expect(report.issues[0]?.severity).toBe('major');
    expect(report.issues[0]?.relatedTo).toBe('The Drowned Bell');
    expect(report.issues[1]?.relatedTo).toBe('');
  });

  it('reads consistent verdicts with no issues', () => {
    const report = parseContinuityReportBody('# Continuity report — X\n**Verdict:** consistent');
    expect(report.verdict).toBe('consistent');
    expect(report.issues).toHaveLength(0);
  });
});

describe('ModuleForge end-to-end', () => {
  it('generates the module and refines the flagged artifact automatically', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const options = {
      concept: 'A sunken shrine drives a harbour town mad.',
      sessions: 1,
      npcs: 1,
      locations: 1,
      factions: 0,
      encounters: 0,
      refinePass: true,
    };

    chatMock
      // arc-weaver draft
      .mockResolvedValueOnce(JSON.stringify(ARC_DRAFT))
      // session-chronicler draft
      .mockResolvedValueOnce(
        JSON.stringify({
          name: 'Session 1: Low Tide',
          summary: 'First descent.',
          suggestedTags: [],
          body: '# Session 1',
          sessionNumber: '1',
          recap: '',
          prep: ['Read the arc.'],
          openThreads: ['Where is the diver?'],
        }),
      )
      // worldbuilder location draft
      .mockResolvedValueOnce(
        JSON.stringify({
          name: 'The Drowned Docks',
          summary: 'Flooded piers.',
          suggestedTags: [],
          body: '# Docks',
          locationType: 'district',
          inhabitants: 'Fishers',
          pointsOfInterest: [],
          hooks: [],
        }),
      )
      // npc-smith draft
      .mockResolvedValueOnce(
        JSON.stringify({
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
        }),
      )
      // npc-smith statblock step (npc personas run an extra LLM step)
      .mockResolvedValueOnce(
        JSON.stringify({
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
          traits: [{ name: 'Bell-touched', description: "Immune to the bell's call." }],
          actions: [{ name: 'Ritual dagger', description: 'Melee, 1d4+2.' }],
          cr: '2',
        }),
      )
      // continuity check report
      .mockResolvedValueOnce(JSON.stringify(REPORT_ISSUES))
      // arc-weaver refinement draft
      .mockResolvedValueOnce(
        JSON.stringify({
          ...ARC_DRAFT,
          summary: 'A sunken shrine drives the town mad — docks included.',
          body: '# The Drowned Bell (revised)',
        }),
      );

    const state = await moduleForge.run(campaign, BUILT_IN_PERSONAS, options, []);
    expect(state.phase).toBe('completed');

    const artifacts = await import('@/db/artifactRepo').then((m) =>
      m.listArtifactsByCampaign(campaign.id),
    );
    const names = artifacts.map((artifact) => artifact.name);
    expect(names).toContain('The Drowned Bell');
    expect(names).toContain('Session 1: Low Tide');
    expect(names).toContain('The Drowned Docks');
    expect(names).toContain('Bell-Keeper Oro');
    expect(names.some((name) => name.startsWith('Continuity report —'))).toBe(true);

    // The refine step produced a second version of the flagged arc
    // (order between the two is not guaranteed — same-millisecond stamps).
    const arcVersions = artifacts.filter((artifact) => artifact.name === 'The Drowned Bell');
    expect(arcVersions).toHaveLength(2);
    expect(arcVersions.some((artifact) => artifact.summary.includes('docks included'))).toBe(
      true,
    );

    // Every step is a real run in history.
    const runs = await import('@/db/runRepo').then((m) => m.listRunsByCampaign(campaign.id));
    expect(runs).toHaveLength(6); // 4 generate + 1 review + 1 refine

    const forgeState = moduleForge.getState();
    expect(forgeState.phase).toBe('completed');
    // The refine chain runs exactly one step (the flagged arc).
    expect(forgeState.chain.steps).toHaveLength(1);
    expect(forgeState.chain.steps[0]?.artifactId).not.toBeNull();
  }, 30000);
});

/** Unit coverage for the refine plan builder (engine-created artifacts). */
describe('buildRefineSteps', () => {
  it('builds one refine step for the artifact named in the report', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const { createArtifact } = await import('@/db/artifactRepo');
    const arc = await createArtifact({
      campaignId: campaign.id,
      kind: 'plotarc',
      name: 'The Drowned Bell',
      summary: 'A sunken shrine drives the town mad.',
      body: '# The Drowned Bell',
    });
    const report = await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Continuity report — The Drowned Bell',
      tags: ['continuity'],
      summary: 'Contradiction.',
      body: [
        '# Continuity report — The Drowned Bell',
        '**Verdict:** issues found',
        '- **[major]** The docks are flooded here but intact elsewhere. (relates to: The Drowned Bell)',
      ].join('\n'),
      links: [{ targetId: arc.id, relation: 'continuity-check-of' }],
    });

    const steps = await buildRefineSteps([arc.id, report.id], BUILT_IN_PERSONAS);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.brief).toContain('The Drowned Bell');
    expect(steps[0]?.brief).toContain('Findings to fix');
    expect(steps[0]?.autonomy).toBe('auto');
  });

  it('returns no steps when the verdict is consistent', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const { createArtifact } = await import('@/db/artifactRepo');
    const arc = await createArtifact({
      campaignId: campaign.id,
      kind: 'plotarc',
      name: 'The Drowned Bell',
      summary: '',
      body: '',
    });
    const report = await createArtifact({
      campaignId: campaign.id,
      kind: 'note',
      name: 'Continuity report — The Drowned Bell',
      tags: [],
      summary: '',
      body: '# Continuity report — The Drowned Bell\n**Verdict:** consistent',
      links: [],
    });
    const steps = await buildRefineSteps([arc.id, report.id], BUILT_IN_PERSONAS);
    expect(steps).toHaveLength(0);
  });
});

describe('chain review steps', () => {
  it('chains arc → review and wires the review target to the first artifact', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const arcPersona = BUILT_IN_PERSONAS.find((candidate) => candidate.slug === 'arc-weaver');
    const reviewer = BUILT_IN_PERSONAS.find((candidate) => candidate.slug === 'continuity-editor');
    if (arcPersona === undefined || reviewer === undefined) throw new Error('personas missing');

    chatMock
      .mockResolvedValueOnce(JSON.stringify(ARC_DRAFT))
      .mockResolvedValueOnce(JSON.stringify(REPORT_ISSUES));

    const steps: ChainStepInput[] = [
      { personaId: arcPersona.id, brief: 'Design the arc.', autonomy: 'auto' },
      { personaId: reviewer.id, brief: 'Check the arc.', autonomy: 'auto', reviewTarget: 'first' },
    ];
    const result = await chainRunner.run(campaign, BUILT_IN_PERSONAS, steps, 'auto', []);
    expect(result.status).toBe('completed');
    expect(result.steps.map((step) => step.status)).toEqual(['completed', 'completed']);

    // The review targeted the FIRST produced artifact (the arc) and its
    // report note links back to it with the findings intact.
    const { getArtifact } = await import('@/db/artifactRepo');
    const reportId = result.steps[1]?.artifactId;
    expect(reportId).not.toBeNull();
    const report = await getArtifact(reportId!);
    expect(report?.name).toBe('Continuity report — The Drowned Bell');
    expect(report?.links[0]?.targetId).toBe(result.steps[0]?.artifactId);
    expect(report?.body).toContain('**[major]**');
  }, 30000);
});
