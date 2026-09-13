import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { getArtifact, listArtifactsByCampaign } from '@/db/artifactRepo';
import { createCampaign } from '@/db/campaignRepo';
import { putChunks } from '@/db/chunkRepo';
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
import { batchTargets } from '@/features/modules/post-generation';
import { sha256Hex } from '@/lib/hash';
import { stripWikiLinks, surroundingParagraphs } from '@/lib/wikilinks';
import { clearDatabase } from '../db/helpers';

/**
 * EVERY NPC THE MODULE TEXT PRODUCED GETS AN AUTHORED DESCRIPTION (docs/17
 * rows 133/135, docs/11 §The module-side cast). The owner's report, verbatim in
 * substance: *"When the module creates an NPC inside the TEXT (not inside an
 * encounter) that means that this NPC absolutely needs a description, even if
 * its just a zombie. What happens right now is that those named zombies only
 * get an image on their details, nothing more. No text, no stat block,
 * nothing."* — and, when asked what should happen where the module's own
 * paragraphs already describe her, the ruling that REPLACED row 133's text
 * measurement, verbatim:
 *
 *   "An NPC is named if its a wikilink in the module text. Because that link IS
 *    the name." — and: "Author a description anyway."
 *
 * WHAT THAT MEANS, and what these pins hold:
 *
 * - the module's mention is the MATERIAL the description is written FROM, never
 *   the description itself: there is no threshold, no "is the passage
 *   descriptive enough" question, and no case where the mention stands in for a
 *   description. Row 133's `describesEntity` seam and its
 *   `ENTITY_DESCRIPTION_FLOOR` are DELETED, and the shape scan at the bottom of
 *   this file is the tombstone;
 * - the cast is KEPT — the library numbers, the citation identity, the portrait
 *   — and the description is written through the cited row's existing REFILL
 *   (the only sanctioned write into a cast row): the run targets the row it was
 *   just cast into, the stat block step is skipped with its reason BEFORE any
 *   model call, the citation survives byte-identically and `statBlock` stays
 *   null;
 * - the module's own paragraphs still reach the run, as CONTEXT (the same brief
 *   the ordinary npc arm builds). The anchor is the LINK, not a bare search for
 *   the name string: `surroundingParagraphs` normalizes every wiki token to its
 *   TARGET name before matching, so an ALIASED link (`[[Aunt Agatha|Müllerin]]`)
 *   — whose name never appears in the rendered prose — is still found, and the
 *   raw token rides the brief intact. Pinned below.
 *
 * WHY DELETING THE RULE IS SAFE (the fact this slice rests on, pinned here and
 * in `tests/features/module-post-generation.test.ts`): a batch target is BY
 * CONSTRUCTION a wiki-link of the module text
 * (`post-generation.namesOfKind` → `extractWikiLinks(moduleDocumentText)`), so
 * "is this entity named?" is not a question the batch can ever be asked, and
 * the floor's "the text never mentions the entity" case was unreachable. The
 * old no-clobber guard is replaced by the `hasDetailedEntity` filter in
 * `batchTargets`: a name that already has an authored, detailed row of its own
 * is not a target at all — pinned end to end below.
 *
 * The REAL run engine drives every test here with only the transport faked (the
 * seam `tests/llm/refill-creature-stats.test.ts` uses), so the prose the model
 * authors, the refill's step-off and the row's final bytes are all measured
 * rather than assumed.
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

/** The paragraph that only NAMES her: the owner's "named zombies" list — a
 * paragraph that carries her name and nothing else about her. */
const NAMED_ONLY_PROSE = '**The risen:** [[Aunt Agatha]] and [[Zombie]].';

/**
 * The paragraph that DESCRIBES her: real prose about her, at the mention site.
 * Under row 133 this passage was her whole description and no run was spent.
 * Under the owner's ruling it is CONTEXT — the run happens anyway, and the row
 * carries the AUTHORED prose (the inversion this file pins).
 */
const DESCRIBED_PROSE =
  'The mill wheel turns though the race is dry, and [[Aunt Agatha]] stands at the gate with ' +
  'the flour still on her hands, and she does not blink.';

/**
 * An ALIASED link: the wiki-link's TARGET is her name, the text she is written
 * under is an epithet. Rendered, the prose says "Müllerin" and never says
 * "Aunt Agatha" — so a context anchor that searched for the name string would
 * find nothing. `surroundingParagraphs` normalizes the token to its target
 * name, so the paragraph IS found and the raw token rides the brief.
 */
const ALIASED_PROSE =
  'Die [[Aunt Agatha|Müllerin]] steht am Tor, und das Mehl klebt noch an ihren Händen.';

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

/** Every byte the batch sent to the provider, joined — the honest way to ask
 * "did what the module said about her reach the model?". */
function transportPayload(): string {
  return JSON.stringify(chatMock.mock.calls);
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

/** The cited-row step-off, asserted wherever a description run happened: the
 * statblock step `'skipped'` WITH its reason, one transport call, the citation
 * untouched and `statBlock` null. */
async function expectCastRefill(
  campaignId: Id,
  row: NpcArtifact,
  expectation: { calls: number },
): Promise<void> {
  expect(chatMock).toHaveBeenCalledTimes(expectation.calls);
  const run = await batchRun(campaignId);
  expect(run.status).toBe('completed');
  const statblockStep = run.steps.find((step) => step.name === 'statblock');
  expect(statblockStep?.status).toBe('skipped');
  expect((statblockStep?.output as { skipped?: string }).skipped).toContain('library creature');
  // A REFILL of the row that exists, not a new artifact.
  expect(run.targetArtifactId).toBe(row.id);
  expectCitation(row);
  expect(row.data.statBlock).toBeNull();
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
    // The name the citation is: the model invented an epithet, and it became an
    // ALIAS rather than a rename.
    expect(row.name).toBe(AGATHA);
    expect(row.aliases).toContain(AUTHORED_DRAFT.name);

    await expectCastRefill(campaign.id, row, { calls: 1 });
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastPersistentMock).not.toHaveBeenCalled();
  }, 30_000);

  it('the mention is not the description — it is the MATERIAL: the brief carries it as CONTEXT', async () => {
    const { campaign, module } = await seedModule(NAMED_ONLY_PROSE);

    await runEntityBatch({ module, campaign, kind: 'npc', targets: [{ name: AGATHA }] });

    // What the module said about her reached the model as its own section, so
    // the authored prose is grounded in the module's text rather than invented
    // beside it. `buildEntityBrief`'s label, and the token itself.
    expect(transportPayload()).toContain('Where it is mentioned:');
    expect(transportPayload()).toContain('**The risen:** [[Aunt Agatha]] and [[Zombie]].');
  }, 30_000);
});

/**
 * THE OWNER-RULED INVERSION (docs/17 row 135, reversing part of row 133). Row
 * 133 asked "do the module's paragraphs describe her?" and, when the answer was
 * yes, spent NOTHING and kept the paragraph as the row's prose. The owner ruled
 * the opposite: *"An NPC is named if its a wikilink in the module text. Because
 * that link IS the name."* — *"Author a description anyway."* So the pin that
 * used to assert "no run, the module's paragraph byte for byte" now asserts the
 * opposite: exactly ONE run, and the body IS the authored prose.
 */
describe('an entity the module prose already DESCRIBES gets an authored description anyway (row 135)', () => {
  it('spends exactly ONE run, and the row carries the AUTHORED prose — never the mention', async () => {
    const { campaign, module } = await seedModule(DESCRIBED_PROSE);
    const paragraphs = surroundingParagraphs(moduleDocumentText(module), AGATHA).trim();
    // The fixture really is the passage row 133 would have called a description:
    // it is much longer than the name and says something about her.
    expect(paragraphs).toContain('the flour still on her hands');

    const result = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: [{ name: AGATHA }],
    });

    expect(result.failed).toEqual([]);
    expect(result.cast).toEqual([AGATHA]);
    expect(result.generated).toEqual([]);

    const row = await castRow(campaign.id);
    // THE INVERSION: the authored prose, not the module's paragraph.
    expect(row.body).toBe(AUTHORED_BODY);
    expect(row.body).not.toBe(paragraphs);
    // The module's own opening sentence is nowhere in the row — the mention is
    // material the run was given, not the description it wrote.
    expect(row.body).not.toContain('The mill wheel turns though the race is dry');
    // …while that sentence IS what the run was written FROM.
    expect(transportPayload()).toContain('The mill wheel turns though the race is dry');

    await expectCastRefill(campaign.id, row, { calls: 1 });
    expect(toastErrorMock).not.toHaveBeenCalled();
  }, 30_000);
});

describe('the context anchor is the LINK, not a search for the name string', () => {
  it('an ALIASED [[Name|alias]] link — the name absent from the prose — still gets an authored description with usable context', async () => {
    const { campaign, module } = await seedModule(ALIASED_PROSE);
    const text = moduleDocumentText(module);
    // The premise of this pin, measured: the rendered prose never says her name
    // (it says the epithet), so a name-string search over what a reader sees
    // would find nothing.
    expect(stripWikiLinks(text)).toContain('Müllerin');
    expect(stripWikiLinks(text)).not.toContain(AGATHA);

    // …and the context seam still finds the paragraph, because it normalizes
    // every wiki token to its TARGET name before matching.
    const paragraphs = surroundingParagraphs(text, AGATHA);
    expect(paragraphs).toContain('[[Aunt Agatha|Müllerin]]');

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
    // The raw token — the link AND its alias — rode the brief into the run.
    expect(transportPayload()).toContain('[[Aunt Agatha|Müllerin]]');
    await expectCastRefill(campaign.id, row, { calls: 1 });
  }, 30_000);
});

/**
 * WHAT REPLACES THE OLD NO-CLOBBER GUARD — the load-bearing fact, measured end
 * to end rather than argued. Row 133 needed a guard because it re-read the
 * cast row's own body; under the new rule the guard is the TARGET SET:
 * `post-generation.batchTargets` = `namesOfKind(module, kind)` (the module
 * text's own wiki-links, filtered by the recorded kind) minus every name that
 * already has an authored, detailed entity. A row carrying a description is
 * therefore not a target at all, so the description arm cannot be asked to
 * rewrite it. `castCreatureAsNpc` closes the other half: a same-name row in
 * the module that is not the SAME creature is refused loudly, never taken over
 * (`tests/db/creatureRepo.test.ts`, `D4 — … a rival is refused loudly`). The
 * cast arm itself enters only for `target.artifactId === undefined`, so the
 * change seam (which deliberately re-writes an existing row) never lands here.
 */
describe('a row that carries a description can never be re-targeted by this arm', () => {
  it('once the description lands the name is not a batch target: a second sweep spends nothing and rewrites nothing', async () => {
    const { campaign, module } = await seedModule(NAMED_ONLY_PROSE);
    // Before: she is a wiki-link with no entity of her own — work to do.
    const before = await listArtifactsByCampaign(campaign.id);
    expect(batchTargets(module, before, 'npc')).toEqual([AGATHA]);

    await runEntityBatch({ module, campaign, kind: 'npc', targets: [{ name: AGATHA }] });
    const row = await castRow(campaign.id);
    expect(row.body).toBe(AUTHORED_BODY);

    // After: the row carries an authored description, so `hasDetailedEntity`
    // excludes her — the set the sweep and the panel both work from is empty.
    const after = await listArtifactsByCampaign(campaign.id);
    const targets = batchTargets(module, after, 'npc');
    expect(targets).toEqual([]);

    // …and the batch handed exactly that set does nothing: no run, no write.
    const second = await runEntityBatch({
      module,
      campaign,
      kind: 'npc',
      targets: targets.map((name) => ({ name })),
    });
    expect(second.cast).toEqual([]);
    expect(second.produced).toEqual([]);
    expect(chatMock).toHaveBeenCalledTimes(1);
    expect((await getArtifact(row.id))?.body).toBe(AUTHORED_BODY);
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

  it('reports the failed description through the batch’s one funnel, and the citation is not written', async () => {
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
    // arrived. The name is now a DETAILED entity, so it is no longer a batch
    // target: a retry means dropping the row and generating the entity again,
    // not re-running this same target.
    const row = await castRow(campaign.id);
    expectCitation(row);
    expect(row.data.statBlock).toBeNull();
    expect(row.body).toBe(NAMED_ONLY_PROSE);
    expect(batchTargets(module, await listArtifactsByCampaign(campaign.id), 'npc')).toEqual([]);
    consoleSpy.mockRestore();
  }, 30_000);
});

/**
 * THE TOMBSTONE, and its honest limit. Row 133's seam and its floor are DELETED
 * (docs/17 row 135): they answered a question the batch cannot be asked. This
 * scan holds their absence as a SHAPE, so nobody resurrects a second spelling
 * of the rule.
 *
 * WHAT A TEXTUAL SCAN CANNOT SEE, stated plainly: it cannot see a DEAD
 * CONDITION. A re-added `if (someAlwaysFalseTest(...)) return;` in the cast
 * branch, or a rule that is never reached, would satisfy every assertion here.
 * That is what the behavioural pins above are for — they drive the REAL engine
 * and read the row's bytes, so a rule that executes and changes nothing (or a
 * return that is taken) is caught there, not here.
 *
 * THE ONE EXCLUSION, by exact path: this file's own header names both deleted
 * identifiers, because a tombstone has to say what it buries — so it is skipped
 * as the scanner's own source and nothing else is. Everything under `src/` and
 * every other test file is walked, with no other skip.
 */
describe('the deleted description seam stays deleted (source scan)', () => {
  it('neither the seam nor its floor is spelled anywhere in src/ or tests/, and the cast branch has no early return before its run', async () => {
    const nodeFs = await import('node:fs');
    const nodePath = await import('node:path');
    /** This scanner's own path, the sole exclusion (see above). */
    const SCANNER = 'features/entity-batch-cast-description.test.ts';

    const files: { path: string; text: string }[] = [];
    const walk = (root: string, dir: string): void => {
      for (const entry of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(root, full);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        files.push({
          path: nodePath.relative(root, full),
          text: nodeFs.readFileSync(full, 'utf8'),
        });
      }
    };
    for (const root of ['src', 'tests']) walk(root, nodePath.join(process.cwd(), root));
    // Non-vacuity: the walk must see the app AND its tests.
    expect(files.length).toBeGreaterThan(400);
    const batchRelative = files.find((file) => file.path === 'features/modules/entity-batch.ts');
    expect(batchRelative).toBeDefined();

    const scanned = files.filter((file) => file.path !== SCANNER);
    // The exclusion really is one file, and it really is this one.
    expect(files.length - scanned.length).toBe(1);
    const carrying = (needle: string): string[] =>
      scanned.filter((file) => file.text.includes(needle)).map((file) => file.path);
    expect(carrying('describesEntity')).toEqual([]);
    expect(carrying('ENTITY_DESCRIPTION_FLOOR')).toEqual([]);

    // THE CAST BRANCH: no early return between the cast and the authoring run.
    // Comments are stripped first — the prose in that branch discusses the
    // deleted returns by name.
    const batch = scanned.find((file) => file.path === 'features/modules/entity-batch.ts');
    if (batch === undefined) throw new Error('entity-batch.ts is missing from the walk');
    const code = batch.text
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const guard = code.indexOf("if (slot !== null && kind === 'npc' && target.artifactId === undefined) {");
    const authoring = code.indexOf('runId = await runEngine.startRun(', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(authoring).toBeGreaterThan(guard);
    // Sanity on the slice itself: it must really be the cast branch (it casts,
    // then reads the row back), or the assertion below proves nothing.
    const branch = code.slice(guard, authoring);
    expect(branch).toContain('castCreatureAsNpc(');
    expect(branch).toContain('artifactRepo.getArtifact(castOutcome.artifactId)');
    expect(branch.length).toBeGreaterThan(500);
    expect(branch).not.toMatch(/\breturn\b/);
  });
});
