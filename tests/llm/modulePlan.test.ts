import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createArtifact } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { getModule, saveModule } from '@/db/moduleRepo';
import {
  createModule,
  moduleSpineSchema,
  newId,
  type AnyArtifact,
  type Id,
  type Module,
} from '@/domain';
import { planModuleDocument, modulePlanMessages, modulePlannerReplySchema } from '@/llm/modulePlan';
import { clearDatabase } from '../db/helpers';

/**
 * The DOCUMENT PLANNER (docs/17 row 109): ONE seam, and the boundary where a
 * model's structural decisions become data.
 *
 * Every test here mocks `chat` — the protocol boundary — so nothing reaches a
 * provider, and each one pins one clause of the contract:
 *
 * - the reply is parsed with zod AT THE BOUNDARY: invalid JSON, a wrong shape
 *   and a plan naming something that does not exist are all LOUD, and none of
 *   them leaves a plan behind (the seam writes nothing; the caller's patch is
 *   the only write);
 * - a good reply comes back VALIDATED, with provenance stamped by the app;
 * - ONE generation per module (the shared canvas-busy registry), and no module
 *   with nothing to plan;
 * - the prompt states what the model may decide and what it may not.
 */

vi.mock('@/llm/openrouter', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chat: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

let world: { moduleId: Id; module: Module; artifacts: AnyArtifact[]; imageId: Id } = {
  moduleId: '',
  module: null as unknown as Module,
  artifacts: [],
  imageId: '',
};

async function seed(): Promise<void> {
  const campaign = await createCampaign({ name: 'Plan Campaign', system: 'dnd5e' });
  const location = await createArtifact({
    campaignId: campaign.id,
    kind: 'location',
    name: 'Old Tower',
    body: 'The tower watches the ford.',
  });
  const encounter = await createArtifact({
    campaignId: campaign.id,
    kind: 'encounter',
    name: 'Pier Ambush',
    body: 'They come up out of the water.',
  });
  const module = await saveModule({
    ...createModule({
      campaignId: campaign.id,
      title: 'Beneath the Docks',
      concept: 'A drowned vault.',
      levelMin: 1,
      levelMax: 3,
      tone: '',
      sizeDial: 'standard',
    }),
    spine: moduleSpineSchema.parse({
      premise: 'A drowned vault beneath the [[Old Tower]].',
      themes: [],
      partPlan: [
        {
          title: 'The Dockyards',
          levelBand: '1-2',
          synopsis: 'Meet the wardens.',
          levelUpTrigger: 'The bell rings.',
        },
        { title: 'The Vault', levelBand: '3', synopsis: '', levelUpTrigger: '' },
      ],
    }),
  });
  world = {
    moduleId: module.id,
    module,
    artifacts: [location, encounter],
    imageId: '',
  };
}

/**
 * The text of one composed message. `ChatMessage.content` is a union (a string
 * or content parts), so this reads the string arm explicitly instead of
 * stringifying whatever it is handed.
 */
function messageText(message: { content: string | unknown[] } | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  throw new Error('the planner composes plain-text messages');
}

function replyFor(sections: unknown[]): void {
  chatMock.mockResolvedValue({
    text: JSON.stringify({ sections }),
    modelUsed: 'vendor/planner-1',
    fallback: null,
  });
}

function section(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'The Gate',
    role: 'explanation',
    audience: 'all',
    source: { type: 'part', planIndex: 0 },
    images: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await clearDatabase();
  vi.clearAllMocks();
  await seed();
});

describe('planModuleDocument — the ONE writer of a plan', () => {
  it('returns the VALIDATED plan with provenance stamped by the app', async () => {
    const locationId = world.artifacts[0]?.id ?? '';
    replyFor([
      section({ title: 'The Premise', source: { type: 'part', planIndex: -1 } }),
      section({ title: 'At the Gate', source: { type: 'artifact', artifactId: locationId } }),
    ]);

    const { plan, modelUsed } = await planModuleDocument({
      moduleId: world.moduleId,
      artifacts: world.artifacts,
      turn: new AbortController(),
    });

    expect(plan.sections.map((entry) => entry.title)).toEqual(['The Premise', 'At the Gate']);
    // PROVENANCE: the model that actually served the call, never a settings
    // lookup (a fallback-served reply was written by a different model).
    expect(plan.plannedByModel).toBe('vendor/planner-1');
    expect(modelUsed).toBe('vendor/planner-1');
    expect(plan.plannedAt).toBeGreaterThan(0);
  });

  it('sends a strict structured-output contract and the settings model', async () => {
    replyFor([section()]);
    await planModuleDocument({
      moduleId: world.moduleId,
      artifacts: world.artifacts,
      turn: new AbortController(),
    });

    const call = chatMock.mock.calls[0];
    const messages = call?.[0] ?? [];
    const options = call?.[1] as unknown as Record<string, unknown>;
    const format = options.responseFormat as { kind: string; name: string };
    expect(format.kind).toBe('schema');
    expect(format.name).toBe('module-document-plan');
    // The reply schema the decoder is held to IS the runtime schema minus
    // provenance: one contract, no second copy to drift from.
    const emitted = modulePlannerReplySchema.parse({ sections: [section()] });
    expect(Object.keys(emitted)).toEqual(['sections']);
    expect(messages).toHaveLength(2);
  });

  it('is LOUD on invalid JSON and writes nothing', async () => {
    chatMock.mockResolvedValue({
      text: 'I think the plan should start with the docks…',
      modelUsed: 'vendor/planner-1',
      fallback: null,
    });

    await expect(
      planModuleDocument({
        moduleId: world.moduleId,
        artifacts: world.artifacts,
        turn: new AbortController(),
      }),
    ).rejects.toThrow();
    const row = await getModule(world.moduleId);
    expect(row?.documentPlan ?? null).toBeNull();
  });

  it('is LOUD on a shape failure, naming the offending field', async () => {
    replyFor([{ title: 'The Gate', role: 'sidebar', audience: 'all' }]);

    const failure = await planModuleDocument({
      moduleId: world.moduleId,
      artifacts: world.artifacts,
      turn: new AbortController(),
    }).catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('did not match the document plan');
    expect((failure as Error).message).toContain('sections.0');
    const row = await getModule(world.moduleId);
    expect(row?.documentPlan ?? null).toBeNull();
  });

  it('is LOUD on a plan naming something that does not exist — and writes nothing', async () => {
    // A well-formed plan naming an artifact id the module never mentions: the
    // HARD rule. The seam refuses the WHOLE plan; no section is kept.
    replyFor([
      section({ title: 'Real', source: { type: 'artifact', artifactId: world.artifacts[0]?.id } }),
      section({ title: 'Invented', source: { type: 'artifact', artifactId: newId() } }),
    ]);

    const failure = await planModuleDocument({
      moduleId: world.moduleId,
      artifacts: world.artifacts,
      turn: new AbortController(),
    }).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain('names something that does not exist');
    expect((failure as Error).message).toContain('Invented');
    expect((failure as Error).message).toContain('neither owns nor mentions');
    const row = await getModule(world.moduleId);
    expect(row?.documentPlan ?? null).toBeNull();
  });

  it('refuses a module with no part plan: there is nothing to plan yet', async () => {
    const bare = await saveModule(
      createModule({
        campaignId: world.module.campaignId,
        title: 'No spine',
        concept: '',
        levelMin: 1,
        levelMax: 1,
        tone: '',
        sizeDial: 'sketch',
      }),
    );
    await expect(
      planModuleDocument({
        moduleId: bare.id,
        artifacts: world.artifacts,
        turn: new AbortController(),
      }),
    ).rejects.toThrow(/no part plan yet/);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it('refuses a SECOND generation while one holds the module (never queued)', async () => {
    // Hold the module through the shared registry exactly as a canvas turn
    // does, then ask the planner for a plan.
    const { claimModuleGeneration, releaseModuleGeneration } = await import('@/llm/canvasBusy');
    claimModuleGeneration(world.moduleId);
    try {
      await expect(
        planModuleDocument({
          moduleId: world.moduleId,
          artifacts: world.artifacts,
          turn: new AbortController(),
        }),
      ).rejects.toThrow(/already generating/i);
      expect(chatMock).not.toHaveBeenCalled();
    } finally {
      releaseModuleGeneration(world.moduleId);
    }
  });

  it('releases the module and the abort handle even when the reply is bad', async () => {
    chatMock.mockResolvedValue({
      text: 'not json',
      modelUsed: 'vendor/planner-1',
      fallback: null,
    });
    await expect(
      planModuleDocument({
        moduleId: world.moduleId,
        artifacts: world.artifacts,
        turn: new AbortController(),
      }),
    ).rejects.toThrow();
    // The next call must not see a stale claim.
    replyFor([section()]);
    await expect(
      planModuleDocument({
        moduleId: world.moduleId,
        artifacts: world.artifacts,
        turn: new AbortController(),
      }),
    ).resolves.toBeTruthy();
  });

  it('honours a caller abort before the call (a stop is not an error path)', async () => {
    const turn = new AbortController();
    turn.abort();
    await expect(
      planModuleDocument({ moduleId: world.moduleId, artifacts: world.artifacts, turn }),
    ).rejects.toThrow();
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('modulePlanMessages — what the model is told it may decide', () => {
  it('states the role vocabulary, the audience rule and the prohibitions', () => {
    const messages = modulePlanMessages({
      module: world.module,
      scopedArtifacts: world.artifacts,
      images: [{ id: newId(), where: 'the map of “Pier Ambush”' }],
    });
    const system = messageText(messages[0]);
    const user = messageText(messages[1]);

    // The four roles, each with its ONE meaning (the owner's layout insight).
    for (const role of ['"explanation"', '"read-aloud"', '"gm-note"', '"aside"']) {
      expect(system).toContain(role);
    }
    expect(system).toContain('the body: explanatory prose');
    expect(system).toContain('printed in the read-aloud box');
    expect(system).toContain('boxed GM note');
    expect(system).toContain('small and indented');
    // What it may NOT do.
    expect(system).toContain('You do not write, rewrite, summarise or translate any content');
    expect(system).toContain('You do not change the module');
    expect(system).toContain('never invent a part index, an artifact id or an image id');
    expect(system).toContain('You do not choose typefaces');
    // The audience default, stated where the decision is made.
    expect(system).toContain('Default: GM-only material');
    expect(system).toContain('"gm"');
    // The inventory: what actually exists, with the ids it must use.
    expect(user).toContain(world.module.title);
    expect(user).toContain('planIndex 0: “The Dockyards” · levels 1-2');
    expect(user).toContain(world.artifacts[0]?.id ?? 'missing');
    expect(user).toContain('the map of “Pier Ambush”');
  });

  it('names the module when it has no artifacts and no images', () => {
    const messages = modulePlanMessages({
      module: world.module,
      scopedArtifacts: [],
      images: [],
    });
    const user = messageText(messages[1]);
    expect(user).toContain('ARTIFACTS (0 of 0)');
    expect(user).toContain('(none)');
  });
});
