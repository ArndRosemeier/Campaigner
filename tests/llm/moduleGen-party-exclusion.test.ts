import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { saveModule } from '@/db/moduleRepo';
import { updateSettings } from '@/db/settingsRepo';
import {
  createModule,
  moduleCreationPool,
  MODULE_CREATION_EXCLUDED_KINDS,
  visibleToModuleCreation,
  type Campaign,
  type Id,
} from '@/domain';
import { campaignCastContext, runParts, runSpine } from '@/llm/moduleGen';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { fixedCastForEncounter, PARTY_SIZE, partyLevelLine } from '@/llm/roomBudget';
import { renderChatGrounding } from '@/llm/canvasChat';
import { clearDatabase } from '../db/helpers';
import type { ChatResult } from '@/llm/openrouter';

/**
 * The Party is invisible to module creation (owner-ratified rule, docs/17 row
 * 69, verbatim: "The creator is referring to players in the party. The party
 * should not be visible to module creation.").
 *
 * `campaignCastContext` used to list every campaign-scoped row — PCs ARE
 * campaign-scoped by definition — so the spine and parts prompts told the
 * model to REUSE the players' characters. The exclusion is ONE domain
 * constant (`MODULE_CREATION_EXCLUDED_KINDS` → `visibleToModuleCreation` /
 * `moduleCreationPool`), never a scattered `kind !== 'pc'`.
 *
 * This file pins BOTH halves: the Party is gone from every module-creation
 * list, and the reuse feature (the whole point of the cast block) survives.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {
    constructor() {
      super('No OpenRouter API key configured');
      this.name = 'MissingApiKeyError';
    }
  },
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const TEST_MODEL = 'test/fixture-model';

/** The players' characters — the two names module creation must never see. */
const PC_NAME = 'Kael Ashbound';
const SECOND_PC_NAME = 'Mira Vane';
/** The owner's own setting prose: it MAY name the party (boundary, docs/17 row 69). */
const CAMPAIGN_DESCRIPTION =
  'Kael and Mira are hunting whatever rings the submerged bell on the flood tide.';

/** A campaign-scoped entity the reuse feature exists for. */
const SHARED_NPC = 'Bell Warden Ilse';
/** A module-owned row: never in the campaign cast (moduleId is set). */
const OWNED_NPC = 'Owned Cave Sage';

const SPINE_ENTITIES = [
  { name: SHARED_NPC, kind: 'npc' },
  { name: 'The Ringing Below', kind: 'encounter', wants: ['ring the drowned bell', 'keep it silent'], conflictKind: 'combat' },
  { name: 'The Flooded Stair', kind: 'encounter', wants: ['descend the stair', 'hold back the tide'], conflictKind: 'hazard' },
  { name: 'The Wardens Confession', kind: 'encounter', wants: ['name the guilty warden', 'protect the wardens name'], conflictKind: 'social' },
] as const;

const SPINE_REPLY = {
  premise: 'The bell rings beneath the harbor and nobody admits to ringing it.',
  themes: ['duty'],
  partPlan: [
    {
      title: 'The Sunken Quarter',
      levelBand: '1',
      synopsis: 'The party arrives on the low tide and finds the first bodies.',
      levelUpTrigger: 'The bell is found.',
    },
  ],
  entities: SPINE_ENTITIES,
};

const SELF_NORMALIZATION = {
  entities: SPINE_ENTITIES.map((entity) => ({
    name: entity.name,
    canonical: entity.name,
    kind: entity.kind,
    wants: 'wants' in entity ? [...entity.wants] : [],
    conflictKind: 'conflictKind' in entity ? entity.conflictKind : null,
  })),
};

const PART_TEXT =
  'The tide pulls back and the bell answers. [[The Ringing Below]] waits under the nave. ' +
  'Lanterns gutter along the flooded stair while the water climbs another step. '.repeat(3);

function partReply(): ChatResult {
  return { text: PART_TEXT, modelUsed: 'test-model', fallback: null };
}

/** The post-parts pass answers every wiki-link name of the module text. */
function partNormalizationReply(): ChatResult {
  return {
    text: JSON.stringify({
      entities: [
        {
          name: 'The Ringing Below',
          canonical: 'The Ringing Below',
          kind: 'encounter',
          wants: ['ring the drowned bell', 'keep it silent'],
          conflictKind: 'combat',
        },
      ],
    }),
    modelUsed: 'test-model',
    fallback: null,
  };
}

async function seedWorld(): Promise<{ campaign: Campaign; moduleId: Id }> {
  const campaign = await createCampaign({
    name: 'Bellweather',
    system: 'dnd5e',
    description: CAMPAIGN_DESCRIPTION,
  });
  await createArtifact({ campaignId: campaign.id, kind: 'npc', name: SHARED_NPC });
  await createArtifact({ campaignId: campaign.id, kind: 'pc', name: PC_NAME });
  await createArtifact({ campaignId: campaign.id, kind: 'pc', name: SECOND_PC_NAME });
  const owned = createModule({
    campaignId: campaign.id,
    title: 'An Earlier Module',
    concept: 'earlier',
    levelMin: 1,
    levelMax: 1,
    sizeDial: 'standard',
  });
  await saveModule(owned);
  await createArtifact({
    campaignId: campaign.id,
    moduleId: owned.id,
    kind: 'npc',
    name: OWNED_NPC,
  });
  const draft = createModule({
    campaignId: campaign.id,
    title: 'The Drowned Bell',
    concept: 'A harbor bell that rings by itself beneath the water.',
    levelMin: 1,
    levelMax: 1,
    sizeDial: 'standard',
    includePriorModules: true,
  });
  const saved = await saveModule(draft);
  await updateSettings({ defaultChatModel: TEST_MODEL });
  return { campaign, moduleId: saved.id };
}

/** The user prompt of the chat call whose text contains `marker`. */
function promptContaining(marker: string): string {
  for (const [messages] of chatMock.mock.calls) {
    const user = messages.find(
      (message) => message.role === 'user' && typeof message.content === 'string',
    );
    const text = typeof user?.content === 'string' ? user.content : '';
    if (text.includes(marker)) return text;
  }
  throw new Error(`no chat call carried "${marker}"`);
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
});

describe('the module-creation pool', () => {
  it('keeps every kind except the Party — the one domain constant is the only exclusion', () => {
    expect(MODULE_CREATION_EXCLUDED_KINDS).toEqual(['pc']);
    const pc = { name: PC_NAME, kind: 'pc', moduleId: null } as never;
    const npc = { name: SHARED_NPC, kind: 'npc', moduleId: null } as never;
    expect(visibleToModuleCreation(pc)).toBe(false);
    expect(visibleToModuleCreation(npc)).toBe(true);
    expect(moduleCreationPool([pc, npc])).toEqual([npc]);
  });
});

describe('campaignCastContext', () => {
  it('drops the Party and keeps the campaign-scoped rows the cast block exists for', async () => {
    const { campaign } = await seedWorld();
    const { listArtifactsByCampaign } = await import('@/db/artifactRepo');

    const cast = campaignCastContext(await listArtifactsByCampaign(campaign.id));

    expect(cast).toContain(`${SHARED_NPC} (npc)`);
    expect(cast).not.toContain(PC_NAME);
    expect(cast).not.toContain(SECOND_PC_NAME);
    // Module-owned rows were never in the campaign cast.
    expect(cast).not.toContain(OWNED_NPC);
  });

  it('is null when the campaign has nothing but the Party', () => {
    const cast = campaignCastContext([
      { name: PC_NAME, kind: 'pc', moduleId: null } as never,
      { name: SECOND_PC_NAME, kind: 'pc', moduleId: null } as never,
    ]);

    expect(cast).toBeNull();
  });
});

describe('rendered module-creation prompts', () => {
  it('the spine request carries no party member, and still reuses shared campaign names', async () => {
    const { campaign, moduleId } = await seedWorld();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(SPINE_REPLY), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify(SELF_NORMALIZATION),
        modelUsed: 'test-model',
        fallback: null,
      });

    await runSpine(moduleId, campaign);

    const spine = promptContaining('Design the module spine');
    // The Party is invisible in BOTH lists the spine request carries.
    expect(spine).toContain('Existing campaign entities');
    expect(spine).toContain(`${SHARED_NPC} (npc)`);
    expect(spine).toContain('Shared campaign cast');
    expect(spine).not.toContain(PC_NAME);
    expect(spine).not.toContain(SECOND_PC_NAME);
    expect(spine).not.toContain('(pc)');
    // Boundary: the owner's own setting prose is untouched — it MAY name the party.
    expect(spine).toContain(CAMPAIGN_DESCRIPTION);
  }, 30000);

  it('the parts request carries no party member, and still reuses shared campaign names', async () => {
    const { campaign, moduleId } = await seedWorld();
    chatMock
      .mockResolvedValueOnce({ text: JSON.stringify(SPINE_REPLY), modelUsed: 'test-model', fallback: null })
      .mockResolvedValueOnce({
        text: JSON.stringify(SELF_NORMALIZATION),
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce(partReply())
      .mockResolvedValueOnce(partNormalizationReply());

    await runSpine(moduleId, campaign);
    await runParts(moduleId, campaign);

    const part = promptContaining('Write part 1');
    expect(part).toContain('Existing campaign entities');
    expect(part).toContain(`${SHARED_NPC} (npc)`);
    expect(part).toContain('Shared campaign cast');
    expect(part).not.toContain(PC_NAME);
    expect(part).not.toContain(SECOND_PC_NAME);
    expect(part).not.toContain('(pc)');
    expect(part).toContain(CAMPAIGN_DESCRIPTION);
  }, 30000);
});

describe('party-derived context that must not regress', () => {
  it('keeps the encounter LEVEL line — encounter difficulty is about levels, not players', () => {
    expect(partyLevelLine(3)).toBe(`Party of ${String(PARTY_SIZE)} adventurers at level 3.`);
    expect(buildEntityBrief('The Ringing Below', 'scene', 'premise', 3, [])).toContain(
      'Party of 4 adventurers at level 3.',
    );
  });

  it('keeps the fixed cast npc-only — a party member named in the scene is not cast', () => {
    const pool = [
      {
        id: 'pc-1',
        campaignId: 'campaign-1',
        moduleId: null,
        kind: 'pc',
        name: PC_NAME,
        aliases: [],
        updatedAt: 2,
        data: {},
      },
      {
        id: 'npc-1',
        campaignId: 'campaign-1',
        moduleId: null,
        kind: 'npc',
        name: SHARED_NPC,
        aliases: [],
        updatedAt: 1,
        data: { statBlock: null },
      },
    ] as never;

    const cast = fixedCastForEncounter(
      'The Ringing Below',
      `[[${PC_NAME}]] argues with [[${SHARED_NPC}]] beside the bell.`,
      pool,
      null,
    );

    expect(cast.map((member) => member.name)).toEqual([SHARED_NPC]);
  });

  it('keeps the module chat grounding on the owner prose + prior modules', () => {
    const block = renderChatGrounding({
      campaignName: 'Bellweather',
      campaignDescription: CAMPAIGN_DESCRIPTION,
      systemLabel: 'D&D 5e',
      priorModules: [
        {
          title: 'An Earlier Module',
          premise: 'The first module premise.',
          parts: [{ label: '[Part 1 of 1 — Old]', markdown: 'Old part text.' }],
        },
      ],
    });

    expect(block).toContain(CAMPAIGN_DESCRIPTION);
    expect(block).toContain('Previous modules of this campaign');
    expect(block).toContain('Old part text.');
  });
});
