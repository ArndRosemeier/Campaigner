import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
import { castCreatureAsNpc } from '@/db/creatureRepo';
import { db } from '@/db/db';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { createRulebook } from '@/db/rulebookRepo';
import { seedBuiltInPersonas } from '@/db/seed';
import { updateSettings } from '@/db/settingsRepo';
import {
  createModule,
  moduleDocumentText,
  npcCreatureRef,
  ruleChunkSchema,
  statBlockSchema,
  stampNewEntity,
  type Campaign,
  type Id,
  type Module,
  type NpcArtifact,
  type StatBlock,
} from '@/domain';
import { runEntityBatch } from '@/features/modules/entity-batch';
import {
  BATCH_FAILURE_CONSOLE_PREFIX,
  BATCH_FAILURE_RECORD_TAG,
} from '@/features/modules/entity-batch-report';
import { sha256Hex } from '@/lib/hash';
import { describesEntity, surroundingParagraphs } from '@/lib/wikilinks';
import { clearDatabase } from '../db/helpers';

/**
 * THE DESCRIPTION A CAST ROW OWES THE MODULE TEXT (docs/17 row 133, docs/11
 * §The module-side cast). The owner's report, verbatim in substance: *"When the
 * module creates an NPC inside the TEXT (not inside an encounter) that means
 * that this NPC absolutely needs a description, even if its just a zombie. What
 * happens right now is that those named zombies only get an image on their
 * details, nothing more. No text, no stat block, nothing."*
 *
 * MEASURED at the row's birth (this file's fixtures are that row): the cast
 * branch gave the row the module's own paragraphs as its prose — and when the
 * module's text merely NAMES her, or never mentions her at all, that prose was
 * the entity's own name, so the details surface showed a portrait, an empty
 * description and an "Add stat block" button (`resolveDerivedNpcStats` has no
 * caller on that surface; the row's numbers are DERIVED and nothing renders
 * them there — reported as its own finding, docs/18 §4).
 *
 * What is pinned here, with the REAL run engine and only the transport faked
 * (the same seam `tests/llm/refill-creature-stats.test.ts` uses):
 *
 * 1. a mention that only names her → the entity's OWN persona runs AGAINST THE
 *    CAST ROW, and the authored prose lands on it: `creatureRef` intact,
 *    `statBlock` null, and the STATBLOCK STEP NEVER ASKED (the cited row's
 *    refill, decided before the model call — the two calls that prove it are
 *    the chat count and the run's own skipped step);
 * 2. a paragraph that DESCRIBES her → today's behaviour, byte for byte: the
 *    module's own prose, and NO run at all (the cheapness is a feature);
 * 3. a row that already CARRIES a description is never written over — no
 *    second run, no clobber (the cast's own promise);
 * 4. a description run that does not complete is LOUD through the batch's one
 *    funnel, and the cast row keeps its citation and its identity anyway.
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/search', () => ({ searchRules: vi.fn() }));

vi.mock('@/lib/toast', () => ({
  toastError: vi.fn(),
  toastErrorPersistent: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);
const { searchRules } = await import('@/search');
const searchMock = vi.mocked(searchRules);
const { toastError, toastErrorPersistent } = await import('@/lib/toast');
const toastErrorMock = vi.mocked(toastError);
const toastPersistentMock = vi.mocked(toastErrorPersistent);

const TEST_MODEL = 'test/fixture-model';
const AGATHA = 'Aunt Agatha';
const ZOMBIE = 'Zombie';
const CHUNK_ID: Id = '5a4f0c9e-1333-4133-8133-000000000133';

/** The prose the module text does NOT contain: what the entity's own persona
 * authors into the row. Deliberately unlike any module sentence. */
const AUTHORED_BODY =
  'Aunt Agatha kept the mill for forty years and never once let the wheel stop.\n\n' +
  'She came back with the flour still on her hands, and she does not blink.';

const AUTHORED_DRAFT = {
  // A name the MODEL invented, NOT the citation's: the refill keeps the row's
  // own name and files this one as an alias (nothing authored is lost, and the
  // cast's identity is never renamed).
  name: 'Aunt Agatha, the Miller’s Widow',
  summary: 'The miller’s widow, risen with the flour still on her hands.',
  suggestedTags: [],
  body: AUTHORED_BODY,
  appearance: 'Flour-dusted hands, a grey shawl, eyes that do not move.',
  personality: 'Patient, unhurried, and completely silent.',
  // The model's honest answer for a zombie — the answer that must never be
  // allowed to build the refused pair on a cited row.
  needsStatBlock: true,
};

const STAT_BLOCK: StatBlock = statBlockSchema.parse({
  system: 'dnd5e',
  level: '1/4',
  size: 'Medium',
  creatureType: 'undead',
  ac: 8,
  acNote: '',
  hp: 22,
  hpFormula: '3d8+9',
  speed: '20 ft.',
  abilities: { str: 13, dex: 6, con: 16, int: 3, wis: 6, cha: 5 },
  saves: '',
  skills: '',
  senses: 'darkvision 60 ft.',
  languages: 'understands Common but cannot speak',
  traits: [],
  actions: [{ name: 'Slam', text: 'Melee Weapon Attack: +3 to hit.' }],
  reactions: [],
  legendary: [],
  extras: {},
});

/** The DESCRIPTION the module writes about her: real prose, so today's
 * behaviour stands and no run may be spent. */
const DESCRIBED_PROSE =
  'The mill wheel turns though the race is dry, and [[Aunt Agatha]] stands at the gate with ' +
  'the flour still on her hands, and she does not blink.';

/** The mention that only NAMES her: the owner's "named zombies" list — a
 * paragraph that carries her name and nothing else about her. */
const NAMED_ONLY_PROSE = '**The risen:** [[Aunt Agatha]] and [[Zombie]].';

/** Two paragraphs that never mention her at all (the spine declared an entity
 * the text never wrote into a scene) — an empty context. */
const UNMENTIONED_PROSE =
  'The mill wheel turns though the race is dry, and the lane beyond the gate is churned to mud.';

/** One transport boundary for every step the batch can reach: a statblock call
 * (which a cited row must never make) answers with a real block, so a
 * regression that asks for one shows up as a WRITTEN block rather than as a
 * parse failure; everything else answers with the entity's own draft. */
function answerSteps(): (messages: unknown[]) => Promise<{
  text: string;
  modelUsed: string;
  fallback: null;
}> {
  return (messages) => {
    const raw = JSON.stringify(messages);
    const text = raw.includes('Fill the StatBlock for')
      ? JSON.stringify(STAT_BLOCK)
      : JSON.stringify(AUTHORED_DRAFT);
    return Promise.resolve({ text, modelUsed: TEST_MODEL, fallback: null });
  };
}

/** A stat-block chunk in a book: the library creature the entity's record asks
 * to borrow the numbers of. */
async function seedCreature(): Promise<void> {
  const book = await createRulebook({ title: 'Bestiary', system: 'dnd5e', filename: 'bestiary.pdf' });
  const text = `${ZOMBIE}\nMedium undead, neutral evil\nArmor Class 8\nHit Points 22`;
  const chunk = ruleChunkSchema.parse({
    ...stampNewEntity(),
    id: CHUNK_ID,
    bookId: book.id,
    pageStart: 316,
    pageEnd: 316,
    chunkType: 'statblock',
    headingPath: [ZOMBIE],
    text,
    contentHash: await sha256Hex(text),
    statBlock: STAT_BLOCK,
  });
  await putChunks([chunk]);
}

/** Campaign + module whose spine RECORDED the bestiary slot (the request the
 * model made), with one part whose markdown is `partMarkdown`. */
async function seedModule(partMarkdown: string): Promise<{
  campaign: Campaign;
  module: Module;
}> {
  const campaign = await createCampaign({ name: 'Millford', system: 'dnd5e' });
  const saved = await saveModule(
    createModule({
      campaignId: campaign.id,
      title: 'The Walking Mill',
      concept: 'The village dead rise, and one of them is somebody’s aunt.',
      levelMin: 1,
      levelMax: 1,
      tone: 'grief',
      sizeDial: 'sketch',
    }),
  );
  await patchModule(saved.id, {
    status: 'ready',
    spine: {
      premise: 'The graveyard behind the mill has begun to walk.',
      themes: [],
      writerModel: TEST_MODEL,
      origin: null,
      partPlan: [{ title: 'Descent', levelBand: '1', synopsis: '', levelUpTrigger: '' }],
    },
    entityKinds: [{ name: AGATHA, kind: 'npc', absorbed: [], bestiary: { creature: ZOMBIE } }],
    entityNamesNormalized: true,
    parts: [
      {
        planIndex: 0,
        markdown: partMarkdown,
        status: 'ready',
        errorMessage: '',
        edited: false,
        writerModel: TEST_MODEL,
        origin: null,
      },
    ],
  });
  const module = await getModule(saved.id);
  if (module === undefined) throw new Error('the module row is missing');
  await seedCreature();
  await seedBuiltInPersonas();
  return { campaign, module };
}

/** The citation is IDENTITY, not content: the chunk the numbers come from and
 * the library's own spelling of the creature's name. (`contentHash` is stamped
 * at citation birth by the ONE cast function, so it is asserted as PRESENT and
 * not as a literal this file would have to re-derive.) */
function expectCitation(row: NpcArtifact): void {
  const ref = npcCreatureRef(row);
  expect(ref?.chunkId).toBe(CHUNK_ID);
  expect(ref?.creatureName).toBe(ZOMBIE);
  expect(ref?.contentHash).toBeDefined();
}

/** The row the batch produced for `AGATHA` — asserted to be an npc row. */
async function castRow(campaignId: Id) {
  const rows = (await listArtifactsByCampaign(campaignId)).filter(
    (row) => row.kind === 'npc' && row.name === AGATHA,
  );
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row?.kind !== 'npc') throw new Error('the cast row is missing');
  return row;
}

/** The batch's own run, read back from the Runs table (the batch returns no run
 * id: its failure records carry one, its successes do not). */
async function batchRun(campaignId: Id) {
  const runs = await db.runs.toArray();
  const run = runs.find((candidate) => candidate.campaignId === campaignId);
  if (run === undefined) throw new Error('no run row was written for this batch');
  return run;
}

beforeEach(async () => {
  await clearDatabase();
  chatMock.mockReset();
  chatMock.mockImplementation(answerSteps());
  searchMock.mockReset();
  searchMock.mockResolvedValue([]);
  toastErrorMock.mockReset();
  toastPersistentMock.mockReset();
  await updateSettings({ defaultChatModel: TEST_MODEL });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearDatabase();
});

describe('a cast row the module text only NAMES gets an authored description', () => {
  it('runs the entity’s own persona AGAINST the row: prose authored, citation intact, stat block step never asked', async () => {
    const { campaign, module } = await seedModule(NAMED_ONLY_PROSE);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.failed).toEqual([]);
    // CAST, not generated: the artifact is the CAST's (library numbers, portrait
    // cache, citation identity) — the run only wrote its prose.
    expect(result.cast).toEqual([AGATHA]);
    expect(result.generated).toEqual([]);
    expect(result.produced).toHaveLength(1);

    const row = await castRow(campaign.id);
    // THE AUTHORED DESCRIPTION IS ON THE ROW, and it is not the name, not the
    // module's mention: the model's own text.
    expect(row.body).toBe(AUTHORED_BODY);
    expect(row.body).not.toBe(AGATHA);
    expect(row.data.appearance).toBe(AUTHORED_DRAFT.appearance);
    expect(row.data.personality).toBe(AUTHORED_DRAFT.personality);
    // The citation is IDENTITY, not content: byte-identical after the write.
    expectCitation(row);
    // …and no authored block was born beside it (the pair the schema refuses).
    expect(row.data.statBlock).toBeNull();
    // The name the citation is: the model invented an epithet, and it became an
    // ALIAS rather than a rename.
    expect(row.name).toBe(AGATHA);
    expect(row.aliases).toContain(AUTHORED_DRAFT.name);

    // THE STEP-OFF HELD: the draft was the ONLY call — a statblock call would
    // have answered with a real block, which the run would then have had to
    // refuse beside the citation.
    expect(chatMock).toHaveBeenCalledTimes(1);
    const run = await batchRun(campaign.id);
    expect(run.status).toBe('completed');
    const statblockStep = run.steps.find((step) => step.name === 'statblock');
    expect(statblockStep?.status).toBe('skipped');
    expect((statblockStep?.output as { skipped?: string }).skipped).toContain('library creature');
    // The run is a REFILL: it filled the row the cast made instead of creating
    // a second artifact of that name.
    expect(run.targetArtifactId).toBe(row.id);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastPersistentMock).not.toHaveBeenCalled();
  }, 30_000);

  it('an entity the text NEVER mentions is the same case: the mention is not the description', async () => {
    const { campaign, module } = await seedModule(UNMENTIONED_PROSE);
    // The module text about her is EMPTY, so the row is born with her name as
    // its body — the state the owner read as "nothing more than an image".
    expect(surroundingParagraphs(moduleDocumentText(module), AGATHA)).toBe('');

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.failed).toEqual([]);
    expect(result.cast).toEqual([AGATHA]);
    const row = await castRow(campaign.id);
    expect(row.body).toBe(AUTHORED_BODY);
    expectCitation(row);
    expect(row.data.statBlock).toBeNull();
    expect(chatMock).toHaveBeenCalledTimes(1);
  }, 30_000);
});

describe('a cast row the module text DESCRIBES keeps the module’s own prose', () => {
  it('spends no run at all, and the row carries the module’s paragraph byte for byte', async () => {
    const { campaign, module } = await seedModule(DESCRIBED_PROSE);
    const paragraphs = surroundingParagraphs(moduleDocumentText(module), AGATHA).trim();
    // The fixture really is the "described" side of the threshold.
    expect(describesEntity(paragraphs, AGATHA)).toBe(true);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.failed).toEqual([]);
    expect(result.cast).toEqual([AGATHA]);
    // THE CHEAPNESS IS THE FEATURE (docs/11: the module's own paragraphs ARE the
    // description): not one model call, and no run row at all.
    expect(chatMock).not.toHaveBeenCalled();
    expect(await db.runs.toArray()).toEqual([]);

    const row = await castRow(campaign.id);
    expect(row.body).toBe(paragraphs);
    expect(row.body).toContain('the flour still on her hands');
    expectCitation(row);
    expect(row.data.statBlock).toBeNull();
  }, 30_000);

  it('a row that already CARRIES a description is never written over — no second run', async () => {
    const { campaign, module } = await seedModule(NAMED_ONLY_PROSE);
    // A row cast earlier (the popover, another batch) whose prose has since been
    // written — by a model or by hand.
    const existing = await castCreatureAsNpc({
      campaignId: campaign.id,
      moduleId: module.id,
      citation: { chunkId: CHUNK_ID, creatureName: ZOMBIE },
      name: AGATHA,
      prose: { body: 'She was the miller’s wife, and the mill has not turned since she died.' },
    });

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.failed).toEqual([]);
    expect(result.cast).toEqual([AGATHA]);
    // The cast's own promise: a second cast writes NOTHING to the row, and its
    // prose is never clobbered (AGENTS rule 1).
    expect(chatMock).not.toHaveBeenCalled();
    expect(await db.runs.toArray()).toEqual([]);
    const after = await getArtifact(existing.artifactId);
    expect(after?.body).toBe(
      'She was the miller’s wife, and the mill has not turned since she died.',
    );
  }, 30_000);
});

describe('a description run that does not complete is loud, and the cast still stands', () => {
  /** The funnel's pasteable line, parsed back out of the console. */
  function recordLines(spy: MockInstance<(...data: unknown[]) => void>): Record<string, unknown>[] {
    const prefix = `${BATCH_FAILURE_CONSOLE_PREFIX} ${BATCH_FAILURE_RECORD_TAG} `;
    return spy.mock.calls
      .map((call) => call[0])
      .filter((value): value is string => typeof value === 'string' && value.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
  }

  it('reports the failed description through the batch’s one funnel, and nothing is written', async () => {
    const { campaign, module } = await seedModule(NAMED_ONLY_PROSE);
    // The provider answers nothing parseable — twice (the contract's one repair
    // turn), so the run dies on its own with the engine's own sentence.
    chatMock.mockReset();
    chatMock.mockResolvedValue({ text: 'I am afraid I cannot do that.', modelUsed: TEST_MODEL, fallback: null });
    // A spy replaces the console-hygiene guard's own wrapper, so driving a
    // failing batch is allowed AND the record itself is the assertion.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    // The CAST landed and is reported as a cast; the description did not.
    expect(result.cast).toEqual([AGATHA]);
    expect(result.generated).toEqual([]);
    const [failure] = result.failed;
    expect(failure?.name).toBe(AGATHA);
    expect(failure?.kind).toBe('run-not-completed');
    expect(failure?.status).toBe('failed');
    expect(failure?.runId).toBeDefined();
    expect(failure?.errorMessage ?? '').not.toBe('');
    // The RAW engine row rides along (the reporting layer reads the row, never a
    // flattened sentence).
    expect((failure?.raw as { status?: string }).status).toBe('failed');
    // …and it is WRITTEN DOWN through the one funnel, as a pasteable record.
    const records = recordLines(consoleSpy);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe(AGATHA);
    expect(records[0]?.kind).toBe('run-not-completed');
    expect(records[0]?.batchKind).toBe('npc');

    // The row keeps everything the cast gave it: the citation, the numbers'
    // identity — and the thin birth prose, because the description never
    // arrived (re-running the entity retries exactly this arm).
    const row = await castRow(campaign.id);
    expectCitation(row);
    expect(row.data.statBlock).toBeNull();
    expect(row.body).toBe(NAMED_ONLY_PROSE);
    consoleSpy.mockRestore();
  }, 30_000);
});

/**
 * A FOLD IS INVISIBLE TO BEHAVIOUR (docs/08 §REVERT-PROVEN, the ledger 77/176/60
 * lesson): centralizing the description decision changes no output a behavioural
 * pin can see, so the SHAPE is held here — one seam, asked from the batch, and
 * no second copy of the rule anywhere in `src/`.
 */
describe('the description decision is ONE seam (source scan)', () => {
  it('the rule lives in exactly one file, and the batch only ASKS it', async () => {
    const fs = await import('node:fs/promises');
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    const root = nodePath.join(process.cwd(), 'src');
    const files: { path: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        files.push({ path: full.slice(root.length + 1), text: nodeFs.readFileSync(full, 'utf8') });
      }
    };
    walk(root);
    // Non-vacuity: the walk must see the app.
    expect(files.length).toBeGreaterThan(200);

    // The FLOOR and the name-stripping are the rule, and they exist in ONE file.
    expect(
      files.filter((file) => file.text.includes('ENTITY_DESCRIPTION_FLOOR')).map((file) => file.path),
    ).toEqual(['lib/wikilinks.ts']);
    expect(
      files.filter((file) => file.text.includes('escapeRegExp(')).map((file) => file.path),
    ).toEqual(['lib/wikilinks.ts']);

    // The batch asks the question TWICE, through the seam — the module's own
    // paragraphs, and the row's own body. A count, not `>= 1`: a third copy of
    // the decision at a call site has to be a deliberate, test-visible act.
    const batch = await fs.readFile('src/features/modules/entity-batch.ts', 'utf8');
    expect(batch.match(/describesEntity\(/g) ?? []).toHaveLength(2);
    // …and no call site re-states any part of it: a hand-rolled length check or
    // name-strip in the batch would be a second mechanism for one idea.
    expect(batch).not.toContain('ENTITY_DESCRIPTION_FLOOR');
    expect(batch).not.toContain('replaceAll(/\\s+/g, ');
  });
});
