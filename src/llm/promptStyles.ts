import {
  PROMPT_STYLE_CLASSIC_ID,
  PROMPT_STYLE_FREESTYLE_ID,
  PROMPT_STYLE_SECTION_MARKERS,
  type ModulePromptStyle,
  type PromptStyle,
} from '@/domain/promptStyle';

/**
 * The CONTRACT layer and the built-in styles (owner-directed, docs/17 rows 86
 * and 87).
 *
 * The prompt is two layers:
 *
 * - the STYLE layer — editable text a user owns (voice, shape, craft emphasis).
 *   It arrives as a `templateText` with named placeholders;
 * - the CONTRACT layer — the clauses the rest of the app depends on (the reply
 *   format, the wiki-link rules, the GM-address rule, the length target, the
 *   encounter-floor clauses, the artifact-separation rules). A style PLACES
 *   these clauses (each contract slot is a required placeholder), but the text
 *   is fixed here and no style can weaken it: the validator refuses a template
 *   that drops a contract slot, and the composer refuses to run one.
 *
 * `classic` is the PRE-STYLE instruction text, moved verbatim out of
 * `moduleGen.ts` — with it (and no per-module override) the composed spine and
 * parts prompts are byte-identical to what the app sent before this feature,
 * pinned by `tests/llm/promptStyles-classic-identity.test.ts` against fixtures
 * captured from the pre-refactor builders. `story` is the narrative shape the
 * owner asked for, and `freestyle` is the shape-free experiment he asked for
 * next: the setting, the technology and a goal, and no structure on top.
 */

/** The JSON reply contract the spine callback parses (contract slot). */
const SPINE_REPLY_FORMAT =
  'Reply with ONLY a JSON object: { "premise": string, "themes": string[], "partPlan": [{ "title": string, "levelBand": string, "synopsis": string, "levelUpTrigger": string }], "entities": [{ "name": string, "kind": "npc" | "location" | "event" | "faction" | "note" | "encounter" }] } — partPlan length 1..20, one entity entry per named entity with its kind.';

/** The entity-kind vocabulary (contract slot). */
const SPINE_ENTITY_KINDS =
  '- List every named entity you introduce with its kind: "npc" (a person or creature the party meets), "location" (a place), "event" (a non-combat scene the party plays through; same shape as a location), "faction" (an organization or group), "encounter" (a fight — a battle map and a monster roster), or "note" (anything else — items, rumors, mysteries, plot devices). One entry per named entity, one canonical spelling — a person is listed once, not once per role or title. Reuse existing campaign entities by exact name; never duplicate one to fill the floor.';

/**
 * What an encounter IS (contract slot). Load-bearing: `post-generation` gives
 * battle maps and mob portraits to artifacts whose recorded kind is
 * `encounter` and nothing else.
 */
const SPINE_SCENE_KINDS =
  '- An "encounter" is a FIGHT: initiative, a battle map with terrain, and a monster roster with images. Anything that is not a fight — a negotiation, a hazard, a puzzle, an investigation, a ritual, a chase — is an "event" instead: it gets an illustration and no battle map, no monsters, no roster. Never declare a non-combat scene as an encounter, and never hide a fight inside an event. A hazard or a puzzle still carries meaningful risk and player agency — only its artifact differs.';

/** The wiki-link rule (contract slot): a name links or it cannot be resolved. */
const SPINE_WIKI_LINKS =
  '- Introduce as many locations, NPCs, factions, notes, events and encounters as the story needs — none of them must be detailed here. Give every scene a distinctive, stable name, declare it with its kind in entities, and wiki-link it in prose ([[Scene Name]]) so it can be resolved into its artifact later.';

/** The parts reply format: plain markdown, and the reader adds the H1. */
const PARTS_REPLY_FORMAT =
  '- Free-form GM-facing markdown; ## and ### section headings are allowed (the reader adds the H1 part title — do NOT start your reply with an H1).';

/** The GM address rule (contract slot). */
const PARTS_GM_ADDRESS =
  '- Address the GM, never the players: write what the world and its people do. Never author what a player character does, says, thinks or feels.';

/**
 * The wiki-link rules (contract slot). Every proper noun links or the module
 * cannot resolve it into an artifact; the canonical-spelling half keeps the
 * glossary's recorded spellings authoritative so two names never fork one
 * entity.
 */
const PARTS_WIKI_LINKS = [
  '- Wiki-link every proper noun as [[Name]]: NPCs, locations, factions, artifacts, monsters — and every scene ([[Encounter Name]] for a fight, [[Event Name]] for anything else). Reuse the exact names of entities from earlier parts and the campaign index, consistently.',
  "- Canonical spellings: link glossary entities only by their listed exact spelling. Never inflect inside the token ([[Halmund]]s Haus, not [[Halmunds]] Haus — English genitive: [[Halmund]]'s tower) and never bake a role or title into it ([[Halmund|the guard Halmund]], not [[Guard Halmund]]). Use [[Name|display]] when the surface text must differ. Same rules in any language.",
].join('\n');

/**
 * How the app consumes the prose (contract slot): mechanics live in linked
 * artifacts, and a fight is written as a set-up, never as a roster — the
 * encounter artifact owns the map, the monsters and the tactics.
 */
const PARTS_MECHANICS = [
  '- No stat blocks in the prose — mechanics belong to linked entities. Reference DCs/checks inline where natural.',
  '- Encounters live in separate encounter artifacts — in the prose, set up the fight and link it as [[Encounter Name]]; do NOT write the encounter itself (no monster roster with counts, no tactics or terrain rules, no battle map or ASCII map — those belong to the linked encounter artifact).',
].join('\n');

/** Encounter casting (contract slot): the pipeline casts the rank and file. */
const PARTS_ENCOUNTER_CASTING =
  '- In encounter scenes, name only the fixed participants ([[Halvar]] the boss, the duelist, the negotiator) — rank-and-file fighters stay anonymous and undescribed by name (no names, no counts), so the encounter pipeline casts them.';

/**
 * The finale-aware closing demand (data value for `{{partEnding}}`): the run's
 * plan position decides which of the two sentences the part gets.
 */
export const PART_ENDING_LINES = {
  finale:
    '- This is the FINALE: satisfaction is allowed here, at full price — every want met must be paid for visibly in loss, consequence, or foregone alternative.',
  regular:
    '- End this part with a cost, a revelation, or a new pressure that carries into the next part — never with every side satisfied. Satisfaction is rationed to the finale.',
} as const;

/**
 * The ten labels of the classic scene block (08 §M4-B-2, docs/17 row 73), kept
 * as the ONE source of the classic template's field bullets: a label can never
 * be dropped from the classic copy without failing a test. They are CLASSIC
 * ONLY — the `story` style writes beats, has no ordered field list, and the
 * test asserting the labels appear nowhere in it is the guard for that.
 */
export const PART_SCENE_FIELD_LABELS = [
  'Scene heading + tag',
  'Where',
  'First impression',
  'Who is here and what they want right now',
  'The situation',
  'What changed',
  'If the party acts',
  'Secrets',
  'Leads',
  'Outcome',
] as const;

/**
 * The classic scene block's field-by-field instruction list (one bullet per
 * label, in order). Rendered into the CLASSIC template only.
 */
function classicSceneFieldBullets(): string[] {
  const [heading, where, impression, who, situation, changed, acts, secrets, leads, outcome] =
    PART_SCENE_FIELD_LABELS;
  return [
    `- **${heading}** — name the scene and tag it in the heading, as a wiki-link to the scene's own entity: "### [[Scene Name]] — ENCOUNTER". ENCOUNTER means a fight with real stakes (it gets a battle map, a monster roster and images); EVENT means everything else — a negotiation, a chase, a hazard, a mystery, a puzzle, an investigation (illustration only: no map, no monsters). Combat being merely possible does not make a scene an ENCOUNTER: tag it by what the scene is FOR. Link every scene this way — a scene named only in passing prose is not a scene the module can stand on.`,
    `- **${where}** — link the existing location entity with the document's wiki-link syntax ([[Place Name]]); never invent a location inline.`,
    `- **${impression}** — EXACTLY one or two sentences, present tense, one concrete sense plus one thing that is out of place. No history, no faction names, no explanation of causes, and never the party's actions or feelings. THIS IS THE ONLY TEXT A GM READS ALOUD: everything else on the block is GM-facing.`,
    `- **${who}** — one clause per NPC present, saying what that NPC wants in this scene. Each NPC speaks about what they want and otherwise deflects or refuses.`,
    `- **${situation}** — the conflict already running when the party arrives, and what it does in the next few minutes if nobody intervenes.`,
    `- **${changed}** — the one thing different from the previous scene's state, and the cost the party pays to engage with it. If you could honestly write "the situation is the same, now what do you do", this is not a scene — rewrite it or delete it.`,
    `- **${acts}** — 2-4 bullets of the form <a plausible party action> -> <what the opposition does>. Different bullets must lead to genuinely different outcomes: two routes reaching the same place are one bullet.`,
    `- **${secrets}** — 0-2 per scene, each written abstract from where it is found so a GM can move it. Nothing the party NEEDS may be available from only one place.`,
    `- **${leads}** — each lead names the entity it points at and why it is worth following. A lead that points nowhere is deleted.`,
    `- **${outcome}** — graded: success, partial success and failure written separately. Failure must cost something specific AND move the situation forward: a failed attempt is a new situation, never a dead end.`,
  ];
}

/**
 * The anti-formula rule that rides IMMEDIATELY next to the classic field list
 * (docs/17 row 73), kept as the ONE source of the classic template's demand
 * bullets and pinned verbatim by test. Classic only: without a field list the
 * "orders information / not a form" half has nothing to refer to, so the story
 * style carries its own wording of the disciplines that survive it (no two
 * beats share a pattern, a beat without stakes is cut rather than padded).
 */
export const PART_SCENE_VARIATION_DEMANDS = [
  'The block ORDERS information for the GM. It is not a form to fill in.',
  'Scenes differ from each other in length, shape and voice. Any field may be a single short line when the scene is small — do not pad a field to look complete, and never write filler to satisfy a label.',
  'Do not give every scene the same symmetric structure, and do not repeat one beat pattern (arrive, talk, fight) across the part or the module.',
  'The fields never dictate what happens. If a scene has nothing at stake, rewrite it or delete it — never pour prose into the labels to fill them.',
] as const;

/**
 * The classic SPINE section: today's planner instruction, verbatim, with the
 * contract clauses lifted out to their slots and the run-dependent numbers
 * lifted out to placeholders.
 */
function classicSpineSection(): string {
  return [
    '{{campaign}}',
    '',
    '{{moduleConcept}}',
    '',
    '{{partyLevels}}',
    '',
    '{{campaignIndex}}',
    '',
    '{{priorModules}}',
    '',
    'Design the module spine. Cover the whole level range with parts, in order:',
    `- Default one part per level; you MAY merge adjacent levels into one part when the story is better served (levels {{levelMin}}–{{levelMax}} → about {{levelCount}} parts or fewer).`,
    '- Every level in the range must be covered by exactly one part.',
    '- Each part needs: title, levelBand (e.g. "1" or "2-3"), a one-paragraph synopsis, and levelUpTrigger (what ends this part / triggers the level-up). Write the synopsis as a GM-facing note with scene-level substance: the situation, the actors, the stakes, and at least one concrete scene the part contains.',
    '- Think like an experienced GM: prioritize meaningful choices, varied pacing, clear stakes, and challenges that are exciting without feeling arbitrary. Let the fiction and pacing decide the structure — never a quota.',
    '- {{contract.floor}}Place encounters deliberately in the parts where they make narrative and gameplay sense, and reserve climactic encounters for an earned escalation.',
    '- Conflict first: the situation is contested by someone — a faction, an NPC, a predator, a rival party, or the place itself — and who carries that conflict may shift as the module runs. Not every module has an antagonist; every module has a conflict.',
    '- Every situation offers at least two VISIBLE approaches that differ in cost or consequence, so nothing resolves on a single route and no part is a passive wait for the plot. Two rolls toward the same outcome are one approach: the difference must be one the players can see before they commit.',
    '- State in the premise how the situation can resolve, and keep every part equal to what the premise promises — a promised siege arrives, a promised traitor is present and reachable.',
    '- Give each faction an order of battle — wants, needs, preferred tactics, fears, when it flees — and advance its own plan between parts whether or not the party engages it. Every returnable location gets a line of what has changed since.',
    '- If an antagonist exists, the party meets their agents, aftereffects or evidence from the first part — never a villain held back for the finale.',
    '- Every encounter and every location carries one concrete particular that could not be swapped out unchanged (a named river, a debt, a smell, a rule of the place): an opponent the party cannot tell apart from the last one is meaningless combat, and interchangeable scenery is the same failure more slowly.',
    '- Keep the PCs the protagonists: no NPC ally is more intimately bound to the plot than they are, and no NPC solves what the party came to solve.',
    '- Opportunistic threats (a predator, a bandit group, a patrol) belong to the situation: each one advances or reveals a faction’s plan instead of appearing as filler. Exploring is never punished as such — wherever it leads, the interesting thing found there must be worth the risk.',
    '- Structural conflict governs HOW scenes resolve, never what they feel like — no tone, register or subject matter is restricted here. Every conflict ends with someone worse off, a cost paid, or a new problem opened: the losing side is bought, beaten or outmaneuvered, never talked out of its want; a compromise costs a party something it needed; the resolution is built from what the party found and did, never revealed as an unearned third option. Satisfaction is rationed to the finale.{{toneBans}}',
    '- When the party defeats, bypasses or changes something, that change persists and is visible when they return: a beaten antagonist stays beaten unless the fiction earned the return, and no NPC finds, captures or sets back the party by fiat.',
    '{{contract.wikiLinks}}',
    '{{contract.sceneKinds}}',
    '{{contract.entityKinds}}',
    '- Also write a premise (a few paragraphs of markdown — the intro section of the module) and 1-5 themes.',
    '- Before you answer, the three things that do not bend: (1) every situation has at least two visible approaches that differ in cost or consequence — no single-route conclusions; (2) every conflict ends with someone worse off, a cost paid, or a new problem opened; (3) what the party changes stays changed and stays visible when they return.',
    "- The user's premise, tone, level range and size are FIXED INPUT. Do not restate, extend, soften or contradict them. If a structural requirement cannot be met inside the user's premise, change the STRUCTURE (the part plan, which faction carries the conflict, where the conflict starts) — never the premise. If you believe the premise makes a requirement impossible, satisfy the requirement anyway and say what you changed in the structure notes.",
    '',
    '{{additionalInstruction}}',
    '',
    '{{contract.replyFormat}}',
  ].join('\n');
}

/**
 * The classic PARTS section: today's writer instruction, verbatim, with the
 * contract clauses lifted out to their slots and the run-dependent pieces
 * (`{{partEnding}}`) lifted out to placeholders.
 */
function classicPartsSection(): string {
  return [
    '{{campaign}}',
    '',
    '{{modulePremise}}',
    '',
    '{{themes}}',
    '',
    '{{allParts}}',
    '',
    '{{partHeading}}',
    '',
    '{{partSynopsis}}',
    '',
    '{{partEndCondition}}',
    '',
    '{{previousPart}}',
    '',
    '{{ruleExcerpts}}',
    '',
    '{{glossary}}',
    '',
    '{{campaignIndex}}',
    '',
    '{{priorModules}}',
    '',
    'Writing instructions:',
    '{{contract.replyFormat}}',
    '- Write the part as SCENES. Every scene that has anything at stake is written as one labeled block, with these fields in this order:',
    ...classicSceneFieldBullets(),
    ...PART_SCENE_VARIATION_DEMANDS.map((demand) => `- ${demand}`),
    '- No scene may require one specific party action to proceed. If the party does nothing, the relevant faction simply advances its own plan.',
    '{{contract.gmAddress}}',
    '- Introduce at most one new entity per scene, and use it in the scene that introduces it.',
    '- End the part with at least two threads pointing into other parts.',
    '- Every situation in this part offers at least two VISIBLE approaches that differ in cost or consequence — two rolls toward the same outcome are one approach. Nothing resolves on a single route.',
    '- Every conflict ends with someone worse off, a cost paid, or a new problem opened: the losing side is bought, beaten or outmaneuvered, never talked out of its want; a compromise costs a party something it needed; the resolution is built from what the party found and did, never revealed as an unearned third option.',
    '- When the party defeats, bypasses or changes something, write the change into the fiction so it is still visible when they look again — nothing they accomplished is undone off-screen, and nobody locates or captures them by fiat.',
    '{{contract.wikiLinks}}',
    '{{contract.lengthTarget}}',
    '{{contract.floor}}',
    '{{partEnding}}',
    '- If an antagonist exists, keep their agents, aftereffects or evidence on the page from here on — never hold the villain back for the finale.',
    '- Show one faction advancing its own plan in this part, whether or not the party engages it; when the party returns to a place they have been, open with what has changed since.',
    '- Every encounter and every location in this part carries one concrete particular that could not be swapped out unchanged: an opponent the party cannot tell apart from the last one is meaningless combat.',
    '- Keep the PCs the protagonists: no NPC ally is more intimately bound to the plot than they are, and no NPC solves what the party came to solve.',
    '- Opportunistic threats (a predator, a patrol, a bandit group) advance or reveal a faction’s plan instead of appearing as filler, and exploring is never punished as such — whatever the party finds must be worth the risk it took.',
    '{{contract.mechanics}}',
    '- A scene that is NOT a fight is an event: link it as [[Event Name]] and write its whole block right here in the prose (the block above is what an event gets). An event receives an illustration and nothing else: no battle map, no monsters, no roster, because none is generated for it.',
    '{{contract.encounterCasting}}',
    '- Before you answer, the three things that do not bend in this part: (1) at least two visible approaches per situation, differing in cost or consequence, so nothing resolves on a single route; (2) every conflict ends with someone worse off, a cost paid, or a new problem opened; (3) what the party changes stays changed and stays visible.',
    '',
    '{{additionalInstruction}}',
  ].join('\n');
}

/**
 * The freestyle PARTS section (owner request, docs/17 row 87): the SETTING, the
 * TECHNOLOGY and a GOAL — and NO shape at all.
 *
 * The owner asked to experiment with a style that prescribes nothing on top of
 * those three things: *"i would like you to add a 'Freestyle' option where just
 * the setting and the technology is explained and the goal to make this a
 * noteworthy and fun module to play, no actual structure given on top of that.
 * I want to experiment with that. All artefact types and the encounter floor
 * still need to be explained."* So there is deliberately NO field list, NO
 * beat-heading template and NONE of the craft-discipline bullets the other two
 * built-ins carry — no "two visible approaches", no "end the part with two
 * threads", no "every conflict ends with a cost": those are Classic's and
 * Story's creative prescriptions, and seeing what the model does without them
 * is the point of this style.
 *
 * What it does carry, and why neither half is creative preference:
 *
 * - the SETTING: every context placeholder the other built-ins use (campaign,
 *   premise, themes, the all-parts synopses, this part's heading / synopsis /
 *   end condition, the previous part's markdown, rule excerpts, the module
 *   glossary, the campaign index, prior modules, a one-off additional
 *   instruction). A part prompt without them writes a different module than the
 *   one the planner approved.
 * - the TECHNOLOGY: the text is what a GM runs a table from; every proper noun
 *   written as a `[[wiki-link]]` becomes a real artifact the app builds out;
 *   the six artifact kinds and what the app builds per kind; and the encounter
 *   floor, whose NUMBERS arrive through `{{contract.floor}}` and are never
 *   restated here (a style that repeated the numbers could disagree with the
 *   gate that counts them).
 * - the GOAL: a noteworthy and fun module to play.
 *
 * WHERE THE FORM IS STATED, and what that does NOT change. Classic and Story
 * carry "name each scene/beat with a heading that carries its own [[link]]" as a
 * FORMAT requirement; Freestyle states the same underlying app behavior as
 * TECHNOLOGY instead — the app builds an artifact from every linked name, and it
 * counts a part's encounters from the linked names whose recorded entity kind is
 * `encounter` (`encounterNamesIn` / `countModuleEncounters`), so a fight becomes
 * countable by being named, linked and declared with that kind — and then leaves
 * the form to the model. That boundary (a fight written only inside a sentence,
 * never named or linked, is invisible to the count) is PRE-EXISTING for every
 * style, not something this one introduces, and it is what the contract's own
 * link rules already carry. The encounter floor itself is IDENTICAL for all
 * three styles: the same `{{contract.floor}}` clauses, verbatim, with the
 * module's own numbers; nothing here weakens it, and no claim is made that a
 * freestyle part complies with it differently.
 *
 * The SPINE section is Classic's, verbatim — a judgement call, reported and the
 * owner's to veto (docs/08 §Editable prompt styles, docs/17 row 87): the
 * planner's reply is a JSON contract (`partPlan`), its instruction is already
 * conflict-first rather than formulaic, and the plan is scaffolding the owner
 * does not read, while the part text is what he is experimenting with.
 */
function freestylePartsSection(): string {
  return [
    '{{campaign}}',
    '',
    '{{modulePremise}}',
    '',
    '{{themes}}',
    '',
    '{{allParts}}',
    '',
    '{{partHeading}}',
    '',
    '{{partSynopsis}}',
    '',
    '{{partEndCondition}}',
    '',
    '{{previousPart}}',
    '',
    '{{ruleExcerpts}}',
    '',
    '{{glossary}}',
    '',
    '{{campaignIndex}}',
    '',
    '{{priorModules}}',
    '',
    'Write this part of the module.',
    '{{contract.replyFormat}}',
    '',
    'What the app does with your text, so you know what you are writing: this is the module a GM runs a table from. Every proper noun you write as a [[wiki-link]] becomes a real artifact the app builds out — its own generated details, its own generated images, its own card in front of the GM. A name you never link stays prose the app can do nothing with, and one name linked in two spellings forks into two artifacts.',
    '',
    'The artifact kinds the app can build, and what each one gets:',
    '- "npc" — a person or creature the party meets.',
    '- "location" — a place.',
    '- "event" — a non-combat scene the party plays through: a negotiation, a hazard, a puzzle, an investigation, a chase. An event gets an illustration and nothing else — no battle map, no monsters, no roster.',
    '- "faction" — an organization or group.',
    '- "encounter" — a FIGHT, and the app builds it as one: a battle map, a monster roster, and images (mob portraits) generated for it. Anything that is not a fight is an event and never an encounter, and a fight buried in an event gets no map, no monsters and no roster.',
    '- "note" — anything else: items, rumors, mysteries, plot devices.',
    '',
    'Player characters are not yours to write — the players author them — and no player character is an entity this module declares. "plotarc" is not an entity kind the module declares either.',
    '',
    'Name and link what you create, fights included: the app builds an artifact from every linked name and counts your encounters from them, so a fight staged only in passing prose is invisible to the app. The module entities above are the names and kinds already recorded for this module — link those by their exact spellings, and reuse the campaign entities listed above instead of inventing a second name for something that already exists.',
    '',
    'Whenever this module carries an encounter floor, that floor is a hard requirement the app checks the finished part against: a fight is what satisfies it and anything that is not a fight cannot. Its numbers are stated in the requirement line here and are never yours to restate, round, soften or work around.',
    '{{contract.floor}}',
    '',
    'The goal: make this a noteworthy and fun module to play. The setting and the technology above are what you have to work with; how the part is written is yours to decide — there is no prescribed shape, no field list and no beat template here.',
    '',
    'What the app needs from every module, whichever style writes it:',
    '{{contract.gmAddress}}',
    '{{contract.wikiLinks}}',
    '{{contract.mechanics}}',
    '{{contract.encounterCasting}}',
    '{{contract.lengthTarget}}',
    '',
    '{{additionalInstruction}}',
  ].join('\n');
}

/**
 * The story PARTS section (owner-directed): the part IS the story the GM plays,
 * told in the order it happens. The ten-field block is gone — the model chooses
 * each beat's shape, no two beats share a pattern, and length follows the
 * material. What survives is SUBSTANCE (stakes, two visible approaches, a
 * conflict that costs something, changes that stick, one new entity per beat,
 * at least two threads into other parts) plus ONE structural anchor: the beat
 * heading that carries its own wiki-link, which is load-bearing because the
 * encounter floor is counted from wiki-linked names whose recorded entity kind
 * is `encounter` — the heading WORD is not what the counter reads.
 */
function storyPartsSection(): string {
  return [
    '{{campaign}}',
    '',
    '{{modulePremise}}',
    '',
    '{{themes}}',
    '',
    '{{allParts}}',
    '',
    '{{partHeading}}',
    '',
    '{{partSynopsis}}',
    '',
    '{{partEndCondition}}',
    '',
    '{{previousPart}}',
    '',
    '{{ruleExcerpts}}',
    '',
    '{{glossary}}',
    '',
    '{{campaignIndex}}',
    '',
    '{{priorModules}}',
    '',
    'Write this part as the story the GM plays, in the order it happens: what the party comes upon, who is here and what they want, what is already in motion, what happens if nobody intervenes, and how it can go — and what it costs. A GM reads it as a scenario to run, not a form to fill in.',
    'Choose the shape of each beat yourself. A beat can be a conversation, a journey, a chase, a fight, a discovery, a negotiation — whatever this part’s material actually is. No two beats share a pattern, and a beat takes the length its material deserves.',
    '{{contract.replyFormat}}',
    '- Name each beat that has anything at stake with a heading that carries its own wiki-link: "### [[Beat Name]]". The link is load-bearing, not decoration: a beat the app cannot resolve as an entity is lost to the module afterwards, and the encounters this part must account for are counted from the wiki-linked names whose recorded kind is "encounter". A FIGHT adds the word ENCOUNTER to that heading ("### [[Beat Name]] — ENCOUNTER"); anything else gets EVENT ("### [[Beat Name]] — EVENT").',
    '- A beat with nothing at stake is cut or rewritten, never padded. If nothing has changed when the party arrives, it is not a beat.',
    '- When a beat opens, give the GM one or two sentences of what the party sees and hears — the sentence they read aloud. Keep it to what is in front of them: no history, no explanation of causes, and never the party’s actions or feelings.',
    '- Every beat with a conflict in it offers at least two VISIBLE approaches that differ in cost or consequence — two rolls toward the same outcome are one approach. Nothing resolves on a single route.',
    '- A conflict ends with someone worse off, a cost paid, or a new problem opened: the losing side is bought, beaten or outmaneuvered, never talked out of its want; a compromise costs the party something it needed; the resolution comes out of what the party found and did, never an unearned third option.',
    '- Nothing the party changes is undone off-screen. Whatever they beat, bypass or bargain with stays changed when they look again, and nobody locates, captures or sets them back by fiat.',
    '- If nobody intervenes, the situation moves on its own: say who acts and what that does. A passive party is never a stalled part.',
    '- Introduce at most one new entity per beat, and use it in the beat that introduces it.',
    '- End the part with at least two threads pointing into other parts.',
    '{{contract.gmAddress}}',
    '{{contract.wikiLinks}}',
    '{{contract.lengthTarget}}',
    '{{contract.floor}}',
    '{{partEnding}}',
    '{{contract.mechanics}}',
    '{{contract.encounterCasting}}',
    '',
    '{{additionalInstruction}}',
  ].join('\n');
}

/**
 * The built-in styles, immutable and shipped in code. Each is a complete
 * template: a user duplicates one (`basedOn`) and edits the copy.
 *
 * TWO of the three deliberately carry the CLASSIC spine section — the story
 * style, because the planner prompt is already story-first (conflict first,
 * stakes, no quotas) and its JSON shape is an app contract, so the narrative
 * rewrite the owner asked for lands where the story is actually written (the
 * part prompt); and the freestyle style, as a JUDGEMENT CALL the owner can veto
 * (docs/17 row 87): the planner's reply is a JSON contract, its instruction is
 * not formulaic, and the plan is scaffolding rather than the text the owner
 * reads — freestyling the planner too is a follow-up he can ask for. Freestyle
 * is also the PRODUCT default for a fresh app (docs/17 row 88) — the owner's
 * choice after generating with it — while the SPINE section it inherits stays
 * the planner's.
 */
export const BUILTIN_PROMPT_STYLES: readonly PromptStyle[] = [
  {
    id: PROMPT_STYLE_CLASSIC_ID,
    name: 'Classic',
    origin: 'builtin',
    version: 1,
    templateText: `${PROMPT_STYLE_SECTION_MARKERS.spine}\n${classicSpineSection()}\n\n${PROMPT_STYLE_SECTION_MARKERS.parts}\n${classicPartsSection()}\n`,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'story',
    name: 'Story',
    origin: 'builtin',
    version: 1,
    templateText: `${PROMPT_STYLE_SECTION_MARKERS.spine}\n${classicSpineSection()}\n\n${PROMPT_STYLE_SECTION_MARKERS.parts}\n${storyPartsSection()}\n`,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: PROMPT_STYLE_FREESTYLE_ID,
    name: 'Freestyle',
    origin: 'builtin',
    version: 1,
    templateText: `${PROMPT_STYLE_SECTION_MARKERS.spine}\n${classicSpineSection()}\n\n${PROMPT_STYLE_SECTION_MARKERS.parts}\n${freestylePartsSection()}\n`,
    createdAt: 0,
    updatedAt: 0,
  },
];

/** A built-in style by id, or undefined. */
export function builtinPromptStyle(id: string): PromptStyle | undefined {
  return BUILTIN_PROMPT_STYLES.find((style) => style.id === id);
}

/** The style record a MODULE stores (the identity + the text it was written in). */
export function modulePromptStyleOf(style: PromptStyle): ModulePromptStyle {
  return {
    id: style.id,
    name: style.name,
    version: style.version,
    templateText: style.templateText,
  };
}

/**
 * The style a module is written in.
 *
 * A module with a RECORDED style uses the text it recorded, always — that is
 * what makes resume, repair and per-part regeneration keep the voice the module
 * started in after the style was edited or deleted.
 *
 * A module with NO recorded style is a module written before styles existed,
 * and it was written with Classic: that is the text that existed when it was
 * written, so reading it back as Classic is the honest reading of the record —
 * provenance, not a fallback to a default (AGENTS rule 1 is about masking
 * failures; this is not a failure). The consequence is pinned by test: a legacy
 * row composes the byte-identical classic prompt it would have composed before
 * this feature, so a resumed legacy module's new parts match its existing ones.
 *
 * The resolution ORDER is therefore: the module's RECORDED style → and, when
 * nothing was recorded, Classic by PROVENANCE. The app default
 * (`settings.defaultPromptStyleId`, today Freestyle — docs/17 row 88) is
 * deliberately NOT reachable from here: it is the style a module that does not
 * exist yet is CREATED in (`resolveCreationPromptStyle`, `src/llm/moduleGen.ts`),
 * and consulting it here would silently re-voice every module written before
 * styles existed on the next resume, repair or per-part regeneration.
 */
export function promptStyleForModule(module: {
  promptStyle?: ModulePromptStyle | null | undefined;
}): { source: 'recorded' | 'legacy-classic'; style: ModulePromptStyle } {
  if (module.promptStyle !== null && module.promptStyle !== undefined) {
    return { source: 'recorded', style: module.promptStyle };
  }
  const classic = builtinPromptStyle(PROMPT_STYLE_CLASSIC_ID);
  if (classic === undefined) {
    throw new Error('The built-in Classic prompt style is missing from the build');
  }
  return { source: 'legacy-classic', style: modulePromptStyleOf(classic) };
}

/** The contract values for a spine run. */
export function spineContractValues(input: { floorClause: string | null }): Record<string, string> {
  return {
    'contract.replyFormat': SPINE_REPLY_FORMAT,
    'contract.entityKinds': SPINE_ENTITY_KINDS,
    'contract.sceneKinds': SPINE_SCENE_KINDS,
    'contract.wikiLinks': SPINE_WIKI_LINKS,
    // Inline slot: the clause carries its own trailing space, so a disabled
    // floor leaves the sentence it rides intact (pre-style behavior).
    'contract.floor': input.floorClause === null ? '' : `${input.floorClause} `,
  };
}

/** The contract values for a part run. */
export function partsContractValues(input: {
  lengthTarget: string;
  floorClause: string | null;
}): Record<string, string> {
  return {
    'contract.replyFormat': PARTS_REPLY_FORMAT,
    'contract.gmAddress': PARTS_GM_ADDRESS,
    'contract.wikiLinks': PARTS_WIKI_LINKS,
    'contract.mechanics': PARTS_MECHANICS,
    'contract.encounterCasting': PARTS_ENCOUNTER_CASTING,
    'contract.lengthTarget': `- Target length for this part: ${input.lengthTarget} (soft target).`,
    'contract.floor': input.floorClause === null ? '' : `- ${input.floorClause}`,
  };
}
