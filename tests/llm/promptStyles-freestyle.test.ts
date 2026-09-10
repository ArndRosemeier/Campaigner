import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCampaign } from '@/db/campaignRepo';
import { getModule, patchModule, saveModule } from '@/db/moduleRepo';
import { catalogStyles, readPromptStyleCatalog } from '@/db/promptStyleRepo';
import { getSettings } from '@/db/settingsRepo';
import {
  composePromptFromTemplate,
  createModule,
  PROMPT_STYLE_SECTION_MARKERS,
  requiredPlaceholders,
  validatePromptStyleTemplate,
} from '@/domain';
import {
  BUILTIN_PROMPT_STYLES,
  PART_SCENE_FIELD_LABELS,
  PART_SCENE_VARIATION_DEMANDS,
  builtinPromptStyle,
  modulePromptStyleOf,
  partsContractValues,
  promptStyleForModule,
} from '@/llm/promptStyles';
import { createModuleAndRun, generatePart, runSpine } from '@/llm/moduleGen';
import { clearDatabase } from '../db/helpers';

/**
 * The FREESTYLE built-in (owner request, docs/17 row 87): a third module
 * writing style that prescribes no shape at all — the setting and the
 * technology, plus the goal of a noteworthy, fun module to play.
 *
 * What is pinned here, and why each pin is load-bearing:
 *
 * - the built-in EXISTS as data beside Classic and Story, valid, immutable and
 *   reachable through the ONE catalog both selection surfaces render (the
 *   settings list and the New Module select read `catalogStyles`, never a
 *   hand-kept list);
 * - it composes the SETTING through the real placeholders (every context
 *   placeholder the other built-ins use), so a freestyle part is written for
 *   the module the planner actually approved;
 * - it carries the TECHNOLOGY — the wiki-link→artifact rule, all six artifact
 *   kinds with what the app builds per kind, and the encounter-versus-event
 *   distinction the floor depends on — and the GOAL sentence;
 * - it carries the CONTRACT layer in full, with the floor's numbers arriving
 *   ONLY through `{{contract.floor}}` (a style that restated them could
 *   disagree with the gate that counts them);
 * - it carries NONE of the structure the other two styles prescribe: not the
 *   ten classic field labels, not the anti-formula block that rides them, not
 *   Story's beat-heading template, and none of the craft-discipline bullets
 *   ("two visible approaches", "end with two threads", "every conflict ends
 *   with a cost", the finale-aware closing demand). Those ABSENCES are the
 *   style; the pins are the guard that a later "helpful" edit cannot quietly
 *   turn Freestyle back into Classic.
 *
 * The absence pins are proved NON-VACUOUS by the companion test below: every
 * string they forbid is asserted present in the style that owns it.
 *
 * Classic's byte identity lives in `promptStyles-classic-identity.test.ts` and
 * is untouched by this file: nothing here changes a contract value, and the one
 * string Freestyle shares with Classic is the SPINE section (the reported
 * judgement call — the planner's JSON reply is an app contract and its
 * instruction is not formulaic, so the experiment lands in the part text).
 */

vi.mock('@/llm/openrouter', () => ({
  chat: vi.fn(),
  MissingApiKeyError: class MissingApiKeyError extends Error {},
  OpenRouterError: class OpenRouterError extends Error {},
  listModels: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }));

const mocks = vi.hoisted(() => ({ runModulePostGeneration: vi.fn() }));
vi.mock('@/features/modules/post-generation', () => ({
  runModulePostGeneration: mocks.runModulePostGeneration,
}));

const { chat } = await import('@/llm/openrouter');
const chatMock = vi.mocked(chat);

const FLOOR_CLAUSE =
  'REQUIREMENT — encounter floor for this part (levels 1: 1 level(s)): name at least 1 distinct ' +
  "encounter(s) in this part's markdown as [[Encounter Name]] wiki-links, each a fight with real stakes.";

/** The exact labels the run's own values carry (see `moduleGen.partsMessages`). */
const PARTS_VALUES: Readonly<Record<string, string>> = {
  campaign: 'Campaign: Emberfall (D&D 5e) — a drowned coast.',
  modulePremise: 'Module premise:\nMARKER-PREMISE',
  themes: 'Themes: duty; salt',
  allParts:
    'All parts of this module (one-line synopses, so later parts can foreshadow):\n1. [1] The Sunken Quarter — MARKER-ALLPARTS',
  partHeading: 'Write part 1: "The Sunken Quarter" (levels 1).',
  partSynopsis: 'Part synopsis: MARKER-SYNOPSIS',
  partEndCondition: 'Part ends when: MARKER-ENDCONDITION.',
  previousPart:
    'Full markdown of the previous part (continue seamlessly from it):\n\nMARKER-PREVIOUSPART',
  ruleExcerpts: 'Rule excerpts for grounding:\n[Combat > Actions]\nMARKER-RULES',
  glossary:
    'Module entities — wiki-link these ONLY by these exact canonical spellings:\n- Warden Bellamy (npc)',
  campaignIndex:
    'Existing campaign entities (reuse by exact name where they fit):\n- Saltmarsh (location)',
  priorModules: 'MARKER-PRIORMODULES',
  // Provided so the composer has a value if a style ever asks for it: the point
  // of the pin below is that Freestyle does NOT.
  partEnding: 'MARKER-PARTENDING',
  additionalInstruction: 'Additional instruction from the GM: MARKER-EXTRA',
};

/** Composes one built-in's PARTS prompt with the run's own values. */
function composedParts(
  styleId: string,
  floorClause: string | null = FLOOR_CLAUSE,
): string {
  const style = builtinPromptStyle(styleId);
  if (style === undefined) throw new Error(`the ${styleId} built-in is missing`);
  return composePromptFromTemplate({
    templateText: style.templateText,
    surface: 'parts',
    values: {
      ...PARTS_VALUES,
      ...partsContractValues({ lengthTarget: '800–1500 words', floorClause }),
    },
  }).text;
}

/** The spine or parts section of a template, markers excluded. */
function section(templateText: string, marker: string): string {
  const lines = templateText.split('\n');
  const start = lines.findIndex((line) => line.trim() === marker);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) =>
    Object.values(PROMPT_STYLE_SECTION_MARKERS).some((value) => value === line.trim()),
  );
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** The craft prescriptions Classic and Story carry and Freestyle may not. */
const FORBIDDEN_CRAFT_BULLETS = [
  'two VISIBLE approaches',
  'End the part with at least two threads',
  'Every conflict ends with someone worse off',
  'Introduce at most one new entity per scene',
  'No scene may require one specific party action to proceed',
  'Nothing the party changes is undone off-screen',
  'No two beats share a pattern',
  'A beat with nothing at stake is cut or rewritten',
  'If you could honestly write "the situation is the same, now what do you do"',
  'one or two sentences',
];

const PREMISE = 'A harbor bell that rings by itself beneath the water.';
const PLAN = [
  {
    title: 'The Sunken Quarter',
    levelBand: '1',
    synopsis: 'The party arrives with the low tide.',
    levelUpTrigger: 'The bell is found.',
  },
];
// The floor gate counts encounters: a spine with none is a DEFECT and earns a
// repair call, so the reply plans one.
const SPINE_REPLY = JSON.stringify({
  premise: PREMISE,
  themes: ['duty'],
  partPlan: PLAN,
  entities: [
    { name: 'Warden Bellamy', kind: 'npc' },
    { name: 'The Bells Below', kind: 'encounter' },
  ],
});
const NORM_REPLY = JSON.stringify({
  entities: [
    { name: 'Warden Bellamy', canonical: 'Warden Bellamy', kind: 'npc' },
    { name: 'The Bells Below', canonical: 'The Bells Below', kind: 'encounter' },
  ],
});

/** The composed parts prompt of call `callIndex` of the mocked chat transport. */
function userPrompt(callIndex: number): string {
  const messages = chatMock.mock.calls[callIndex]?.[0] as
    | { role: string; content: unknown }[]
    | undefined;
  const user = messages?.find((message) => message.role === 'user');
  return typeof user?.content === 'string' ? user.content : '';
}

beforeEach(() => clearDatabase());
afterEach(() => {
  vi.resetAllMocks();
});

describe('the Freestyle built-in', () => {
  it('ships as a third immutable built-in beside Classic and Story', () => {
    // REVERT-PROOF: dropping the freestyle entry from BUILTIN_PROMPT_STYLES
    // fails this line, and so does silently reordering the built-ins.
    expect(BUILTIN_PROMPT_STYLES.map((style) => style.id)).toEqual([
      'classic',
      'story',
      'freestyle',
    ]);
    const freestyle = builtinPromptStyle('freestyle');
    expect(freestyle?.name).toBe('Freestyle');
    expect(freestyle?.origin).toBe('builtin');
    expect(freestyle?.version).toBe(1);
    expect(validatePromptStyleTemplate(freestyle?.templateText ?? '')).toEqual([]);
  });

  it('is reachable through the ONE catalog both selection surfaces render', async () => {
    // The settings list and the New Module select both map `catalogStyles`
    // (docs/17 row 86): this is the data-driven path, not a UI assumption.
    const catalog = await readPromptStyleCatalog((await getSettings()).defaultPromptStyleId);
    expect(catalogStyles(catalog).map((style) => style.name)).toEqual([
      'Classic',
      'Story',
      'Freestyle',
    ]);
  });

  it("carries Classic's spine section verbatim (the reported judgement call)", () => {
    const freestyle = builtinPromptStyle('freestyle')?.templateText ?? '';
    const classic = builtinPromptStyle('classic')?.templateText ?? '';
    expect(section(freestyle, PROMPT_STYLE_SECTION_MARKERS.spine)).toBe(
      section(classic, PROMPT_STYLE_SECTION_MARKERS.spine),
    );
    // …and the parts section is emphatically NOT Classic's.
    expect(section(freestyle, PROMPT_STYLE_SECTION_MARKERS.parts)).not.toBe(
      section(classic, PROMPT_STYLE_SECTION_MARKERS.parts),
    );
  });

  it('uses every context placeholder and every required contract clause', () => {
    const text = builtinPromptStyle('freestyle')?.templateText ?? '';
    for (const token of requiredPlaceholders('parts')) {
      expect(text, `missing {{${token}}}`).toContain(`{{${token}}}`);
    }
    for (const token of [
      'campaign',
      'modulePremise',
      'themes',
      'allParts',
      'partHeading',
      'partSynopsis',
      'partEndCondition',
      'previousPart',
      'ruleExcerpts',
      'glossary',
      'campaignIndex',
      'priorModules',
      'additionalInstruction',
    ]) {
      expect(text, `missing the setting placeholder {{${token}}}`).toContain(`{{${token}}}`);
    }
  });

  it('composes the setting through those placeholders, and never restates the floor numbers', () => {
    const text = composedParts('freestyle');
    for (const [token, value] of Object.entries(PARTS_VALUES)) {
      if (token === 'partEnding') continue;
      expect(text, `{{${token}}} did not reach the composed prompt`).toContain(value);
    }
    // The floor arrives through the contract slot, ONCE — the template adds no
    // second statement of it: the numbers belong to the module's own guardrail.
    expect(text).toContain(FLOOR_CLAUSE);
    expect(text.split(FLOOR_CLAUSE)).toHaveLength(2);
    expect(text).not.toContain('{{');
    // The finale-aware closing demand is a craft prescription: not this style's.
    expect(text).not.toContain('MARKER-PARTENDING');
    expect(text).not.toContain('End this part with a cost, a revelation, or a new pressure');
  });

  it('omits the floor clause entirely when the module has no floor', () => {
    const text = composedParts('freestyle', null);
    expect(text).not.toContain('encounter floor for this part');
    // The technology sentence is phrased for exactly this case — it says WHEN a
    // module carries a floor, so a disabled floor leaves nothing false behind.
    expect(text).toContain('Whenever this module carries an encounter floor');
  });

  it('explains every artifact kind and what the app builds per kind', () => {
    const text = composedParts('freestyle');
    // Each kind, in the contract's own vocabulary (`SPINE_ENTITY_KINDS`).
    expect(text).toContain('"npc" — a person or creature the party meets.');
    expect(text).toContain('"location" — a place.');
    expect(text).toContain('"faction" — an organization or group.');
    expect(text).toContain('"note" — anything else: items, rumors, mysteries, plot devices.');
    // An encounter is a FIGHT and the app builds it as one…
    expect(text).toContain('"encounter" — a FIGHT');
    expect(text).toContain('a battle map, a monster roster, and images (mob portraits)');
    // …anything else is an event, illustration only (`SPINE_SCENE_KINDS`).
    expect(text).toContain('"event" — a non-combat scene the party plays through');
    expect(text).toContain(
      'An event gets an illustration and nothing else — no battle map, no monsters, no roster.',
    );
    expect(text).toContain('Anything that is not a fight is an event and never an encounter');
    // Every artifact carries generated detail and images.
    expect(text).toContain('its own generated details, its own generated images');
    // The boundaries the pipeline depends on.
    expect(text).toContain('Player characters are not yours to write');
    expect(text).toContain('"plotarc" is not an entity kind the module declares either.');
    // Link technology — WHY the links matter, not a heading format.
    expect(text).toContain(
      'the app builds an artifact from every linked name and counts your encounters from them',
    );
    expect(text).toContain('a fight staged only in passing prose is invisible to the app');
  });

  it('carries the goal, with the contract layer intact around it', () => {
    const text = composedParts('freestyle');
    expect(text).toContain('make this a noteworthy and fun module to play');
    // Every contract clause, from the ONE source the seam injects, is present.
    for (const clause of Object.values(
      partsContractValues({ lengthTarget: '800–1500 words', floorClause: FLOOR_CLAUSE }),
    )) {
      expect(text, 'a contract clause did not reach the composed prompt').toContain(clause);
    }
    expect(text).toContain('- Target length for this part: 800–1500 words (soft target).');
  });

  it('prescribes NO structure: the field list, the anti-formula block, the beat template and the craft bullets are absent', () => {
    const text = composedParts('freestyle');
    // The ten classic field labels — the ONE source, never a transcribed copy.
    for (const label of PART_SCENE_FIELD_LABELS) {
      expect(text, `the classic field label **${label}** leaked into Freestyle`).not.toContain(
        `**${label}**`,
      );
    }
    // The anti-formula demands that ride them.
    for (const demand of PART_SCENE_VARIATION_DEMANDS) {
      expect(text).not.toContain(demand);
    }
    // Story's beat-heading requirement — and the heading words it insists on.
    expect(text).not.toContain('### [[Beat Name]]');
    expect(text).not.toContain('Name each beat that has anything at stake');
    expect(text).not.toContain('— ENCOUNTER');
    expect(text).not.toContain('— EVENT');
    // The craft-discipline bullets both other styles carry.
    for (const bullet of FORBIDDEN_CRAFT_BULLETS) {
      expect(text, `the craft bullet "${bullet}" leaked into Freestyle`).not.toContain(bullet);
    }
  });

  it('the absence pins are NOT vacuous: every forbidden string is present in the style that owns it', () => {
    const classic = composedParts('classic');
    const story = composedParts('story');
    for (const label of PART_SCENE_FIELD_LABELS) {
      expect(classic, `classic no longer carries **${label}**`).toContain(`**${label}**`);
    }
    for (const demand of PART_SCENE_VARIATION_DEMANDS) {
      expect(classic).toContain(demand);
    }
    expect(story).toContain('### [[Beat Name]]');
    for (const bullet of FORBIDDEN_CRAFT_BULLETS) {
      expect(
        classic.includes(bullet) || story.includes(bullet),
        `no built-in carries "${bullet}", so forbidding it in Freestyle proves nothing`,
      ).toBe(true);
    }
  });
});

describe('a module written in Freestyle', () => {
  it('records the style id, name, version and TEXT, exactly like the other built-ins', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
    const moduleId = await createModuleAndRun(campaign, {
      campaignId: campaign.id,
      title: 'New Module',
      concept: 'A harbor bell.',
      levelMin: 1,
      levelMax: 1,
      tone: '',
      sizeDial: 'standard',
      promptStyleId: 'freestyle',
    });
    const freestyle = builtinPromptStyle('freestyle');
    const row = await getModule(moduleId);
    // REVERT-PROOF: without the built-in, creation fails on the unresolvable id
    // and no module row exists at all.
    expect(row?.promptStyle).toEqual({
      id: 'freestyle',
      name: 'Freestyle',
      version: 1,
      templateText: freestyle?.templateText,
    });
    expect(promptStyleForModule(row ?? {}).source).toBe('recorded');
    // `createModuleAndRun` fires the spine pass DETACHED (`moduleGen.ts`), so
    // drain it here: a spine call still in flight when this test ends would
    // land inside the NEXT test's mocked transport.
    await vi.waitFor(
      async () => {
        expect((await getModule(moduleId))?.spine).not.toBeNull();
      },
      { timeout: 5_000 },
    );
  });

  it('composes a real part from the RECORDED freestyle text', async () => {
    const campaign = await createCampaign({ name: 'Emberfall', system: 'dnd5e' });
    const saved = await saveModule(
      createModule({
        campaignId: campaign.id,
        title: 'The Drowned Bell',
        concept: 'A harbor bell.',
        levelMin: 1,
        levelMax: 1,
        tone: 'eerie',
        sizeDial: 'standard',
      }),
    );
    const freestyle = builtinPromptStyle('freestyle');
    if (freestyle === undefined) throw new Error('missing freestyle');
    await patchModule(saved.id, { promptStyle: modulePromptStyleOf(freestyle) });
    chatMock
      .mockResolvedValueOnce({ text: SPINE_REPLY, modelUsed: 'm', fallback: null })
      .mockResolvedValueOnce({ text: NORM_REPLY, modelUsed: 'm', fallback: null });
    await runSpine(saved.id, campaign);
    // The module's RECORDED text is what composes — not the current built-in
    // (the recording contract, docs/17 row 86): stamp the row's copy and prove
    // the stamp reaches the model.
    await patchModule(saved.id, {
      promptStyle: {
        ...modulePromptStyleOf(freestyle),
        templateText: `${freestyle.templateText}\n\nROW-ONLY-MARKER`,
      },
    });
    const generated = await getModule(saved.id);
    if (generated?.spine == null) throw new Error('the spine pass stored no spine');
    chatMock.mockReset();
    chatMock.mockResolvedValue({
      text: 'PART [[The Bells Below]]: the tide withdraws. '.repeat(6),
      modelUsed: 'm',
      fallback: null,
    });
    await generatePart(saved.id, generated, 0, campaign, 'm', {
      signal: new AbortController().signal,
      extraInstruction: '',
      onToken: undefined,
    });
    const prompt = userPrompt(0);
    expect(prompt).toContain('ROW-ONLY-MARKER');
    // …the setting the run provides…
    expect(prompt).toContain('Campaign: Emberfall');
    expect(prompt).toContain(PREMISE);
    expect(prompt).toContain('Part synopsis: The party arrives with the low tide.');
    expect(prompt).toContain('Part ends when: The bell is found.');
    expect(prompt).toContain(
      'Module entities — wiki-link these ONLY by these exact canonical spellings:',
    );
    expect(prompt).toContain('- The Bells Below (encounter)');
    // …the freestyle technology and the goal…
    expect(prompt).toContain('make this a noteworthy and fun module to play');
    expect(prompt).toContain(
      'there is no prescribed shape, no field list and no beat template here',
    );
    // …the contract layer, the module's own floor clause among it…
    expect(prompt).toContain('Target length for this part:');
    expect(prompt).toContain('encounter floor for this part');
    // …and none of the classic shape.
    for (const label of PART_SCENE_FIELD_LABELS) {
      expect(prompt).not.toContain(`**${label}**`);
    }
  });


  it('leaves a legacy module (no recorded style) on Classic', () => {
    // A NON-REGRESSION GUARD, not new behavior: the same resolution is pinned by
    // `promptStyles-composition.test.ts` and by the Classic-identity suite. It is
    // restated here so this file's story is complete — adding a third built-in
    // must not change what a module without a record composes.
    const resolved = promptStyleForModule({});
    expect(resolved.source).toBe('legacy-classic');
    expect(resolved.style.templateText).toBe(builtinPromptStyle('classic')?.templateText);
    expect(resolved.style.id).toBe('classic');
  });
});
