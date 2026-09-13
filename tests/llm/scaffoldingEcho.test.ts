import 'fake-indexeddb/auto';

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import { createCampaign } from '@/db/campaignRepo';
import { createPersona } from '@/db/personaRepo';
import { listArtifactsByCampaign } from '@/db/artifactRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { getRun } from '@/db/runRepo';
import { createModule, moduleSpineSchema, type Id, type Persona } from '@/domain';
import { buildEntityBrief } from '@/features/modules/persona-request';
import { GROUNDING_SECTION_HEADER } from '@/llm/campaignGrounding';
import { documentTextFields } from '@/llm/generatedTextHygiene';
import { parseSpine, runParts } from '@/llm/moduleGen';
import {
  ENCOUNTER_SOURCE_REPAIR_LEAD_IN,
  ENTITY_CONTEXT_LABEL,
  ENTITY_NAME_VERBATIM_PREFIX,
  ENTITY_NAME_VERBATIM_SUFFIX,
  ENTITY_SCENE_CONTEXT_LABEL,
  ENTITY_SERVE_MODULE_TEXT,
  FACTION_OWNERSHIP_BOUNDARY,
  FIXED_CAST_SECTION_FOOTER,
  FIXED_CAST_SECTION_HEADER,
  INTENT_HIERARCHY,
  INTENT_LABEL,
  MODULE_PREMISE_LABEL,
  PART_TOO_SHORT_REPAIR_SENTENCE,
  PLACE_OWNERSHIP_BOUNDARY,
  SCHEMA_REPAIR_LEAD_IN,
  findScaffoldingEcho,
} from '@/llm/promptScaffolding';
import { runEngine } from '@/llm/runEngine';
import { clearDatabase } from '../db/helpers';

/**
 * Prompt-scaffolding echo (docs/17 row 142, AGENTS rules 1-4).
 *
 * The owner found OUR OWN brief printed into his module: *"The artifact \"name\"
 * field must be exactly \"Nisselkraut\" — verbatim, with no epithets, titles, or
 * additions (put those in the body). Do not invent unrelated sub-plots; make
 * this entity serve the module text. Campaign grounding (derived from
 * wiki-links): -"*. A model echoed the instructions it was handed, and nothing
 * detected the echo, so it was written to a reader-facing document.
 *
 * WHAT THESE PINS ARE. The detector is a full-literal string comparison over
 * strings WE wrote, so it is decidable — the `encounterSourceIssues` /
 * escape-debris pattern, not a gate over prose (docs/18 §4). The pins below
 * assert (i) the reported markers are caught at the REAL persisting boundaries
 * of BOTH generation paths, (ii) the literals come from ONE source shared with
 * the composers, and (iii) ordinary prose that merely talks about the same
 * things passes.
 *
 * WHAT NO TEST HERE CAN PROVE. That a model stops echoing. This seam CATCHES an
 * echo and refuses to persist it; whether the failure rate in real runs is
 * tolerable is something only the owner's runs can show.
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

async function seedPersona(): Promise<{ campaignId: Id; persona: Persona }> {
  const campaign = await createCampaign({ name: 'Test Campaign', system: 'dnd5e' });
  const persona = await createPersona({
    slug: 'npc-smith-scaffolding-echo-test',
    name: 'NPC Smith',
    description: 'test',
    systemPrompt: 'You are a test persona. Reply with JSON only.',
    producesKind: 'npc',
    builtIn: true,
  });
  return { campaignId: campaign.id, persona };
}

const INPUT = (campaignId: Id, persona: Persona) => ({
  campaign: {
    id: campaignId,
    name: 'Test Campaign',
    system: 'dnd5e' as const,
    description: '',
    coverImageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  persona,
  autonomy: 'manual' as const,
  brief: 'a goblin alchemist boss for a level 3 party',
  pinnedChunkIds: [],
});

const VALID_SPINE = {
  premise: 'A harbor town raised its bell to warn of the drownings; now the bell rings by itself.',
  themes: ['duty', 'decay'],
  partPlan: [
    {
      title: 'The Sunken Quarter',
      levelBand: '1',
      synopsis: 'The party arrives with the low tide and finds the first bodies.',
      levelUpTrigger: 'The bell is found.',
    },
    {
      title: 'The Drowned Cathedral',
      levelBand: '2',
      synopsis: 'Descent beneath the harbor to the flooded nave.',
      levelUpTrigger: 'The warden falls.',
    },
  ],
  entities: [],
};

/** Module prose well above the 100-char floor, with a findable marker. */
function partMarkdown(marker: string): string {
  return `${marker}: The tide withdraws and the streets shine wet under a pale sun. `.repeat(4);
}

beforeEach(clearDatabase);
afterEach(() => {
  chatMock.mockReset();
  vi.restoreAllMocks();
});

describe("the marker set is the composers' own bytes (one source)", () => {
  it('the literals the OWNER saw are markers, byte-exact', () => {
    // The report's own strings — if one of these moves, the detector is
    // watching something the model was never sent.
    expect(ENTITY_SERVE_MODULE_TEXT).toBe(
      'Do not invent unrelated sub-plots; make this entity serve the module text.',
    );
    expect(GROUNDING_SECTION_HEADER).toBe('Campaign grounding (derived from wiki-links):');
    expect(ENTITY_CONTEXT_LABEL).toBe('Where it is mentioned:');
    expect(MODULE_PREMISE_LABEL).toBe('Module premise for context:');
    expect(SCHEMA_REPAIR_LEAD_IN).toBe('Your previous reply was invalid JSON for the schema:');
    expect(ENCOUNTER_SOURCE_REPAIR_LEAD_IN).toBe(
      'Your previous reply left monsters without a resolvable stat-block source:',
    );
    expect(PART_TOO_SHORT_REPAIR_SENTENCE).toBe('Your previous reply was too short. Write the full part now.');
  });

  it('the brief we SEND is itself scaffolding — the composer and the detector read the SAME constants', () => {
    // THE one-source pin (AGENTS rule 4). The expected label set is every
    // marker this argument list renders; if a composer stops reading a shared
    // constant and inlines its own wording, the detector no longer matches what
    // was sent, this set loses that label, and THIS test fails — which is the
    // whole point of centralizing the literals.
    const brief = buildEntityBrief(
      'Nisselkraut',
      'The party passes [[Nisselkraut]] on the way inland.',
      'A drowned bell rings on its own.',
      3,
      [{ name: 'Halvar', level: '3', summary: 'Halvar (level 3)', statBlock: null }],
      false,
      'location',
    );
    const found = findScaffoldingEcho(brief).map((hit) => hit.label).sort();
    expect(found).toEqual(
      [
        'the "do not invent unrelated sub-plots" rule',
        'the "Where it is mentioned:" context label',
        'the entity-brief intro line',
        'the fixed-cast section footer',
        'the fixed-cast section header',
        'the location/event ownership boundary',
        'the module-premise label',
        'the verbatim-name rule',
      ].sort(),
    );
  });

  it('the OTHER brief shapes are detected too: the encounter scene label and the faction boundary', () => {
    const scene = 'Two risen lumberjacks stand motionless on the footbridge.';
    const sceneBrief = findScaffoldingEcho(
      buildEntityBrief('The Sunken Bridge', scene, 'premise', 3, [], true, 'encounter'),
    ).map((hit) => hit.label);
    expect(sceneBrief).toContain('the encounter-scene context label');
    expect(sceneBrief).not.toContain('the "Where it is mentioned:" context label');

    const factionBrief = findScaffoldingEcho(
      buildEntityBrief('The Ember Council', 'It holds the harbor.', 'premise', undefined, [], false, 'faction'),
    ).map((hit) => hit.label);
    expect(factionBrief).toContain('the faction ownership boundary');
    expect(factionBrief).not.toContain('the location/event ownership boundary');
  });

  it.each([
    ['the "Where it is mentioned:" context label', ENTITY_CONTEXT_LABEL],
    ['the encounter-scene context label', ENTITY_SCENE_CONTEXT_LABEL],
    ['the module-premise label', MODULE_PREMISE_LABEL],
    ['the "do not invent unrelated sub-plots" rule', ENTITY_SERVE_MODULE_TEXT],
    ['the location/event ownership boundary', PLACE_OWNERSHIP_BOUNDARY],
    ['the faction ownership boundary', FACTION_OWNERSHIP_BOUNDARY],
    ['the entity-intent label', INTENT_LABEL],
    ['the entity-intent hierarchy sentence', INTENT_HIERARCHY],
    ['the grounding section header', GROUNDING_SECTION_HEADER],
    ['the fixed-cast section header', FIXED_CAST_SECTION_HEADER],
    ['the fixed-cast section footer', FIXED_CAST_SECTION_FOOTER],
    ['the schema-repair lead-in', SCHEMA_REPAIR_LEAD_IN],
    ['the encounter-source repair lead-in', ENCOUNTER_SOURCE_REPAIR_LEAD_IN],
    ['the part-too-short repair sentence', PART_TOO_SHORT_REPAIR_SENTENCE],
  ])('every shared literal is DETECTED on its own, as %s', (label, literal) => {
    // A marker that cannot fire is a marker nobody would notice going dead —
    // and this is also the shortest statement of the one-source rule: the
    // literal here IS the constant the composer renders.
    expect(findScaffoldingEcho(literal).map((hit) => hit.label)).toEqual([label]);
  });

  it('a brief CARRYING AN INTENT is detected, both of its literals included (docs/17 row 145)', () => {
    // The gap this pin closes: row 142's detector could not mark the
    // intent paragraph, because its two constants lived in
    // `features/modules/persona-request` and importing them into this seam would
    // have been an import cycle. They moved DOWN to `llm/promptScaffolding`
    // (where the composer now imports them back), and the composed paragraph is
    // byte-identical — `tests/features/entity-intent-brief.test.tsx` transcribes
    // it and stays green UNCHANGED.
    const brief = buildEntityBrief(
      'The Salt Market',
      'The party crosses [[The Salt Market]] at dusk.',
      'A harbor town raised its bell.',
      2,
      [],
      false,
      'location',
      'Park her at the docks.',
      'The market is a front for the smugglers.',
    );
    const found = findScaffoldingEcho(brief).map((hit) => hit.label);
    expect(found).toContain('the entity-intent label');
    expect(found).toContain('the entity-intent hierarchy sentence');
  });

  it('…and a note containing a QUOTE is still detected — the reason the markers are literals', () => {
    // A SLOTTED marker cannot see this note: its slot is `[^\n"]+`, because the
    // entity-brief intro's own slot is a quoted name. The intent note is free
    // prose and legitimately carries quotes, so a slotted form would be silently
    // DEAD here — the exact failure mode the marker set exists to prevent.
    const brief = buildEntityBrief(
      'The Salt Market',
      'The party crosses [[The Salt Market]] at dusk.',
      'A harbor town raised its bell.',
      2,
      [],
      false,
      'location',
      'Park her at the docks.',
      'The "bustle" is a cover; play the stalls as fear.',
    );
    expect(findScaffoldingEcho(brief).map((hit) => hit.label)).toContain('the entity-intent label');
    expect(brief).toContain('The "bustle" is a cover; play the stalls as fear.');
  });

  it('matches the FULL literal, never a fragment — a truncated run of the same words passes', () => {
    // Not a false-positive guard on its own (the next pin is): this is the
    // reason the detector compares whole sentences. Each fragment below is a
    // literal prefix of a real marker and must NOT fire.
    expect(findScaffoldingEcho('Campaign grounding (derived from wiki-links)')).toEqual([]);
    expect(findScaffoldingEcho('Do not invent unrelated sub-plots')).toEqual([]);
    expect(findScaffoldingEcho(`${ENTITY_NAME_VERBATIM_PREFIX}Nisselkraut`)).toEqual([]);
    expect(findScaffoldingEcho('Your previous reply was invalid JSON')).toEqual([]);
  });

  it("a generically similar sentence in the GM's OWN prose stays GREEN (no false positive)", () => {
    // The brief's rule 4: ordinary words about the same subjects are not an
    // echo. Every line here uses the vocabulary of a marker without being one.
    const prose = [
      'The GM should not invent new factions for this part; the module already names two.',
      'Do not invent unrelated sub-plots for the party to chase between sessions.',
      'The party is level 3, and the mill is where it is mentioned in the old ledger.',
      'Campaign grounding from wiki-links is what the settings toggle controls.',
      'Where it is mentioned twice, link the name only once.',
      'The artifact name must be exactly as the wiki-link spells it, epithets and all.',
      'Write the full part now that the tide has turned.',
    ].join('\n\n');
    expect(findScaffoldingEcho(prose)).toEqual([]);
  });

  it("identity fields are NOT this seam's business: names, aliases and tags are out of the scan", () => {
    const fields = documentTextFields(
      {
        name: ENTITY_SERVE_MODULE_TEXT,
        aliases: [ENTITY_CONTEXT_LABEL],
        suggestedTags: [GROUNDING_SECTION_HEADER],
        body: 'She brews by the tide gate.',
        monsters: [{ name: 'Grix', notes: 'Keeps the ledger.' }],
      },
      'draft',
    );
    expect(fields.map((field) => field.field)).toEqual([
      'draft.body',
      'draft.monsters[0].notes',
    ]);
  });
});

describe('the clean brief is byte-identical to before the constants moved', () => {
  // FROZEN BYTES, captured from the BASE COMMIT (`git show HEAD:…` at
  // d94d4e9) by running THAT module: the refactor moved the literals into
  // `llm/promptScaffolding` and changed no byte the model receives. Each string
  // below is `JSON.stringify` of the base output.
  it('npc (context + premise + level)', () => {
    expect(buildEntityBrief('The Gray Nun', '', '', undefined)).toBe("Detail the entity \"The Gray Nun\" for this module. It appears in the module text below — match it exactly by name.\n\nThe artifact \"name\" field must be exactly \"The Gray Nun\" — verbatim, with no epithets, titles, or additions (put those in the body).\n\nDo not invent unrelated sub-plots; make this entity serve the module text.");
  });

  it('encounter (the scene framing, no kind boundary)', () => {
    expect(
      buildEntityBrief(
        'Drowned Warden',
        'The party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.',
        'A flooded chapel hides a cult.',
        3,
        [],
        true,
        'encounter',
      ),
    ).toBe("Detail the entity \"Drowned Warden\" for this module. It appears in the module text below — match it exactly by name.\n\nThe scene this encounter must stage — whatever it states about the opposition and the place is FIXED, and the roster and the map must match it:\n\nThe party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.\n\nModule premise for context:\n\nA flooded chapel hides a cult.\n\nParty of 4 adventurers at level 3.\n\nThe artifact \"name\" field must be exactly \"Drowned Warden\" — verbatim, with no epithets, titles, or additions (put those in the body).\n\nDo not invent unrelated sub-plots; make this entity serve the module text.");
  });

  it('location (the ownership boundary included)', () => {
    expect(
      buildEntityBrief(
        'The Tide Gate',
        'The party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.',
        'A flooded chapel hides a cult.',
        undefined,
        [],
        false,
        'location',
      ),
    ).toBe("Detail the entity \"The Tide Gate\" for this module. It appears in the module text below — match it exactly by name.\n\nWhere it is mentioned:\n\nThe party meets Harbormaster Ilse at the tide gate.\nShe warns of the cult.\n\nModule premise for context:\n\nA flooded chapel hides a cult.\n\nThe artifact \"name\" field must be exactly \"The Tide Gate\" — verbatim, with no epithets, titles, or additions (put those in the body).\n\nDo not invent unrelated sub-plots; make this entity serve the module text.\n\nWhat this artifact OWNS — one fact, one owner: the module prose draws this line itself (\"encounters live in separate encounter artifacts\"), so the OPPOSITION belongs to the encounter artifact — its creatures, their counts, its tactics and how the fight is run are that artifact's content, and that is where a GM gets them. If the story needs the opposition, point at where it is fought by the name the module text's own wiki-link uses instead of describing the opposition here, and write no tactics, no encounter-handling advice and no GM guidance on running the fight. \"inhabitants\" means the people and factions who are here — never monsters. And when the module text you are given is written from the encounter's point of view (fields such as \"If the party acts\", \"Secrets\" or \"Outcome\"), that material belongs to that encounter: do not restate it, do not extend it, and do not turn it into this artifact's own detail.");
  });
});

describe('the ENTITY path: finalize refuses an echoed brief', () => {
  /**
   * (a) and (b): a draft whose PROSE contains the verbatim-name rule, the
   * grounding section header, the "do not invent unrelated sub-plots" rule, the
   * module-premise label or the ownership boundary is rejected loudly, the
   * marker is NAMED with the field it was found in, and nothing persists.
   *
   * The marker strings come from the exported constants — the composer's own
   * bytes — so this cannot pass against a detector watching something else.
   */
  it.each([
    ['the verbatim-name rule', `${ENTITY_NAME_VERBATIM_PREFIX}Nisselkraut${ENTITY_NAME_VERBATIM_SUFFIX}`],
    ['the grounding section header', GROUNDING_SECTION_HEADER],
    ['the "do not invent unrelated sub-plots" rule', ENTITY_SERVE_MODULE_TEXT],
    ['the module-premise label', MODULE_PREMISE_LABEL],
    ['the location/event ownership boundary', PLACE_OWNERSHIP_BOUNDARY],
  ])('rejects a draft body carrying %s, naming the marker and persisting nothing', async (label, marker) => {
    const { campaignId, persona } = await seedPersona();
    const echoedDraft = {
      name: 'Grix',
      summary: 'A goblin alchemist boss.',
      suggestedTags: ['goblin'],
      body: `# Grix\nShe brews by the tide gate.\n\n${marker}`,
      appearance: 'Small, soot-stained, goggles.',
      personality: 'Manic, cheerful, volatile.',
      needsStatBlock: false,
    };
    chatMock.mockResolvedValueOnce({
      text: JSON.stringify(echoedDraft),
      modelUsed: 'test-model',
      fallback: null,
    });

    const runId = await runEngine.startRun(INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.status).toBe('awaiting_user');
    });
    await runEngine.approve(runId, INPUT(campaignId, persona));
    await waitFor(async () => {
      expect((await getRun(runId))?.steps.at(-1)?.name).toBe('finalize');
    });

    const run = await getRun(runId);
    const finalize = run?.steps.at(-1);
    expect(finalize?.status).toBe('rejected');
    const issues = ((finalize?.output as { issues?: unknown }).issues as string[]).join('\n');
    expect(issues).toContain('prompt scaffolding');
    expect(issues).toContain(label);
    expect(issues).toContain('draft.body');
    expect(issues).toContain(marker);
    // Nothing persisted: no artifact, no result link.
    expect(run?.resultArtifactId).toBeNull();
    expect(await listArtifactsByCampaign(campaignId)).toHaveLength(0);
  }, 20000);
});

describe('the MODULE path reaches the SAME seam', () => {
  it('the SPINE boundary refuses a premise that echoes the scaffolding (parseSpine, called by runSpine at 3 sites)', () => {
    const echoed = JSON.stringify({ ...VALID_SPINE, premise: `The bell rings.\n\n${ENTITY_SERVE_MODULE_TEXT}` });
    expect(() => parseSpine(echoed)).toThrow(/prompt scaffolding/);
    expect(() => parseSpine(echoed)).toThrow(/spine\.premise/);
    expect(() => parseSpine(echoed)).toThrow(new RegExp('do not invent unrelated sub-plots'));
    // A CLEAN spine is untouched — parsed, premise byte-identical.
    expect(parseSpine(JSON.stringify(VALID_SPINE)).premise).toBe(VALID_SPINE.premise);
  });

  it('a PART whose prose echoes the scaffolding fails the part, named, and is never persisted', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const saved = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A harbor bell that rings by itself beneath the water.',
        levelMin: 1,
        levelMax: 3,
        tone: 'eerie',
        sizeDial: 'standard',
      }),
    );
    await patchModule(saved.id, { spine: moduleSpineSchema.parse(VALID_SPINE) });
    const encounterVerdict = {
      text: JSON.stringify({
        entities: [{ name: 'Ember Trial', canonical: 'Ember Trial', kind: 'encounter' }],
      }),
      modelUsed: 'test-model',
      fallback: null,
    };
    chatMock
      .mockResolvedValueOnce({
        text: `${partMarkdown('PART-ONE')} ${GROUNDING_SECTION_HEADER}`,
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce(encounterVerdict) // post-parts normalization
      .mockResolvedValueOnce({
        text: `${partMarkdown('PART-ONE-REPAIR')} ${GROUNDING_SECTION_HEADER}`,
        modelUsed: 'test-model',
        fallback: null,
      })
      .mockResolvedValueOnce(encounterVerdict); // re-normalization

    await runParts(saved.id, campaign, { planIndexes: [0] });

    const stored = await getModule(saved.id);
    const part = stored?.parts.find((entry) => entry.planIndex === 0);
    expect(part?.status).toBe('failed');
    expect(part?.markdown).toBe('');
    expect(part?.errorMessage).toContain('prompt scaffolding');
    expect(part?.errorMessage).toContain('the grounding section header');
    expect(part?.errorMessage).not.toContain('PART-ONE');
  }, 20000);
});

describe('SCAN — every boundary that persists generated text runs the ONE scan', () => {
  /**
   * SOURCE scan (not a behavioural pin): the rule-4 half of row 142. The two
   * defect classes ride ONE function, so a boundary that calls the debris half
   * directly would silently lose the scaffolding half — the "bug waiting at the
   * fourth caller" AGENTS rule 4 names. `debrisIssuesForFields(` may appear
   * ONLY inside `lib/encodingHygiene` (its definition) and inside the aggregate.
   */
  it('no boundary calls the debris half directly', async () => {
    const offenders: string[] = [];
    for (const file of await listSourceFiles('src')) {
      const text = await readFile(file, 'utf8');
      if (!text.includes('debrisIssuesForFields(')) continue;
      if (file.endsWith('lib/encodingHygiene.ts') || file.endsWith('llm/generatedTextHygiene.ts')) continue;
      offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the boundaries that persist reader-visible text all call the aggregate', async () => {
    const boundaries = [
      'src/llm/runEngine.ts', // finalize: artifact body/prose + statblock strings
      'src/llm/moduleGen.ts', // the spine save and every part's markdown
      'src/llm/modulePlan.ts', // the document plan's section titles
      'src/llm/canvasRefine.ts', // a selection/part rewrite's replacement
      // ONE applier serves BOTH chat routes since docs/17 row 150: the
      // preview's copy — whose own entry this list used to carry — is
      // deleted, so its scan IS this one. The second half of this test holds
      // the two surface wrappers to that applier, so the preview route
      // cannot lose the aggregate by losing its entry here.
      'src/features/modules/canvas/chatApply.ts', // a chat command's replacement
    ];
    for (const file of boundaries) {
      const text = await readFile(join(process.cwd(), file), 'utf8');
      expect(text, file).toContain('generatedTextScanForFields(');
    }
    // THE ROUTING PIN that replaces the deleted `snapshotChat.ts` entry: each
    // chat surface hands ITS document to the one applier, so neither route
    // can reach a text write without passing the aggregate above.
    const routes: [string, string][] = [
      ['src/features/modules/canvas/chatController.ts', 'editorChatHandle('],
      ['src/features/modules/canvas/snapshotChat.ts', 'stringChatHandle('],
    ];
    for (const [file, handle] of routes) {
      const text = await readFile(join(process.cwd(), file), 'utf8');
      expect(text, file).toContain(handle);
      expect(text, `${file} must not apply text itself`).not.toContain(
        'generatedTextScanForFields(',
      );
    }
  });
});

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(process.cwd(), dir), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listSourceFiles(path)));
    else if (/\.tsx?$/.test(entry.name)) files.push(join(process.cwd(), path));
  }
  return files;
}
