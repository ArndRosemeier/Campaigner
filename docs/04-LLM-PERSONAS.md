# 04 — OpenRouter Client & Persona Engine

## OpenRouter client (`/src/llm/openrouter.ts`)

```ts
interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
interface ChatOptions {
  model: string; temperature: number;
  responseFormat?: 'json' | SchemaResponseFormat;
  // 'json'               → response_format: { type: 'json_object' } (best-effort)
  // SchemaResponseFormat → response_format: { type: 'json_schema',
  //                        json_schema: { name, strict: true, schema } }
  // (build with schemaResponseFormat(name, zodSchema), /src/llm/strictSchema.ts)
  signal?: AbortSignal;
  onToken?: (delta: string) => void;   // streaming callback
  onReasoning?: (delta: string) => void; // reasoning-delta stream (illustration only)
}
async function chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
```

- Endpoint `POST https://openrouter.ai/api/v1/chat/completions`, headers
  `Authorization: Bearer <settings.openRouterApiKey>`,
  `HTTP-Referer: 'https://campaigner.local'`, `X-Title: 'Campaigner'`.
- Always request `stream: true`; parse SSE per the WHATWG spec (`data: {json}` /
  `data: [DONE]`, `:`-prefixed keep-alive comments like `: OPENROUTER PROCESSING`
  are ignored), concatenate `choices[0].delta.content`, invoke `onToken` per delta.
  Reasoning deltas (`delta.reasoning` / `delta.reasoning_content`) drive the
  liveness probe ("thinking") and are forwarded via `onReasoning` for display
  only — they are never appended to the returned answer and never persisted.
- Stream completion: whichever comes first of `[DONE]`, a clean connection
  close, or `choices[0].finish_reason` (the terminal finish_reason repeats on
  OpenRouter's accounting usage chunk — treat it as an accounting frame, not a
  second terminal event). The reader is cancelled on completion/failure so the
  connection returns to the pool.
- Stream failures are surfaced, never hung: a top-level `error` field or
  `finish_reason: "error"` throws `OpenRouterError`; no bytes for 120s (stall
  watchdog, keep-alives count as activity) aborts with a stall error.
- Errors: non-200 → throw `OpenRouterError(status, bodyText)`. 429/5xx: retry
  twice with 2s/8s backoff before throwing. On a 429 a `Retry-After` hint
  (seconds or HTTP-date, capped at 30s) replaces the plain backoff, and every
  backoff carries ±25% jitter so parallel workers do not retry in lockstep.
  Missing API key → throw
  `MissingApiKeyError` (UI catches this and opens Settings).
- Rate limits are per OpenRouter ACCOUNT: paid models have no platform
  request cap (upstream provider limits apply, with automatic provider
  failover), while `:free` models are capped at 20 requests/minute and
  50–1000 requests/day (by lifetime credit history). Mid-stream 429s arrive
  as `finish_reason: "error"` and surface like any other stream failure.
  Parallel generation (Settings → Parallel requests, see 05-UI) multiplies
  simultaneous traffic — keep the level low for `:free` models.
- Model escalation (`/src/llm/modelFallback.ts`): when `fallbackChatModel` is
  set, `chat()` walks `[primary, fallback]` and EVERY failure escalates to
  the next model — owner decision (2026-09-07): "ANY ERROR, ANY AT ALL
  should lead to the fallback." The chain itself is the bound: only an
  exhausted chain fails the call, with one combined error naming every
  model tried (the last error's kind/status survive). The only
  non-escalating errors are the model-independent ones —
  `MissingApiKeyError` (no key fails identically for every model) and
  user-initiated aborts (`AbortError` from the caller's signal; escalating
  would defy the stop; the transport's own watchdog aborts with
  `TimeoutError`, which escalates). 'length' truncation, strict-schema
  rejections, unknown 400s (e.g. Meta's "The response was filtered due to
  the prompt triggering our content management policy.", which
  `FILTER_PATTERN` never matched), watchdog stalls, refusals — all
  escalate. Failure classification (`failureKindOf`/`fallbackReasonFor`,
  'congestion'/'filter'/…) remains as the Details-view ANNOTATION only; it
  no longer gates anything. Vision requests (image input) still skip a
  fallback the cached `/models` data knows is text-only — a text-only
  fallback cannot serve the request at all. `chat()` returns
  `ChatResult { text, modelUsed, fallback }`; run steps persist an
  escalation `notice` so a fallback is visible, never silent.
- Contract repair escalates too: the ONE automatic retry after a schema/
  contract failure runs on the fallback model when configured
  (`repairModel()`; vision repairs via `visionRepairModel()`), because a
  violated contract is usually a capability weakness of the first-try model.
  Under strict structured outputs (below) the decoder can no longer produce
  a wrong SHAPE, so these paths fire rarely (providers that silently ignore
  strict mode) — they are deliberately KEPT for the censorship and
  congestion classes and for parse failures.

### Strict structured outputs (owner decision)

Every contract-shaped chat call sends its zod schema as
`response_format: { type: 'json_schema', json_schema: { name, strict: true,
schema } }`; OpenRouter enforces it token-level for supporting models, so the
model CANNOT produce a wrong shape. `/src/llm/strictSchema.ts` converts and
normalizes each contract to the strict subset:

- `additionalProperties: false` on every object; ALL properties required.
  zod v4 `io:'output'` conversion makes `.default()` fields required (the
  runtime default only fires for non-LLM inputs); `.optional()` fields are
  re-emitted required + nullable and their LLM-facing schemas parse `null`
  back to `undefined` (the "absentable" convention — draft/brief
  `sourceChunkIndex`, `sourceName`, `statBlock`).
- Preprocessors/coercions emit their inner output shape (booleanish →
  boolean, case-insensitive enums → the enum, `z.coerce.number()` →
  integer); the parsers keep tolerating legacy variants for non-strict
  sources (hand edits, old rows, pack imports).
- Free-form `z.record()` properties cannot exist in strict mode — the
  StatBlock `extras` record is DROPPED from the emitted schema: LLM-drafted
  stat blocks carry no extras; hand edits and pack imports still do.
- Constraint keywords (minLength/maxLength/minimum/maximum/minItems/
  maxItems/pattern/format/`default`/`$schema`) are stripped — the zod parse
  at the boundary still enforces them.
- Recursion (`$ref` cycles), record roots and non-object roots throw
  `StrictSchemaError` loudly. No current contract recurses.

Failure behavior (loud, never silent):

- A provider that rejects the schema (HTTP 400/422) is recorded as
  `kind: 'schema-rejected'`, naming the model (Details view). The chain
  escalates to the next model like for any other failure (owner decision
  2026-09-07 — another model may support strict mode); without a fallback
  configured the failure stays loud. No automatic DOWNGRADE exists: the
  strict `json_schema` response_format rides every escalation attempt.
- A model refusal arrives as OpenAI-style `delta.refusal` →
  `kind: 'refusal'`, classified `filter`: with a fallback model configured
  the chain retries censorship there (owner: "we still need repair models,
  for censorship and congestion"); without one the step fails visibly with
  the refusal text.
- Strict mode fixes SHAPE only. All semantic checks are unchanged: fix-02
  uncited-draft repair, verification notices, review pauses. A parse failure
  (a provider ignoring strict mode) still lands in the existing repair
  retry → pause/review path.

The Settings toggle **Strict structured outputs** (`strictOutputs`, default
ON; old rows parse via the post-M3 field convention) is the ONLY way a call
downgrades to the old best-effort `json_object` mode — for models whose
provider genuinely cannot enforce schemas. There is no automatic downgrade
anywhere.

**Coverage (contract-shaped calls):** runEngine draft (all kinds) /
statblock / continuity check / encounter brief; module spine + its repair
retry; entity normalization + its repair retry; encounter-map verify +
vision repair. Pure-prose calls have no zod contract and stay
unconstrained: module part writing (length-only retry), image prompts
(no LLM draft call).

## Built-in personas (`/src/llm/personas/builtins.ts`)

Seed on app start (insert if slug missing; never overwrite user edits).
Milestone 1 shipped **NPC Smith** fully wired; the other definitions are seeded
but their runs reuse the exact same pipeline with different prompts and
`producesKind` (implement in M2 — pipeline must not hardcode NPC anywhere
except step `statblock`, which runs only when `producesKind === 'npc'`).

`producesKind` is required for generate/review personas; image personas
(`mode: 'image'`, M3-A) never produce an artifact and omit it. Image personas
are not chainable (chainRunner/moduleForge reject them).

| slug             | name              | producesKind | mode     | one-line purpose                       |
|------------------|-------------------|--------------|----------|----------------------------------------|
| npc-smith        | NPC Smith         | npc          | generate | Memorable NPCs with stat blocks         |
| worldbuilder     | Worldbuilder      | location     | generate | Regions, cities, dungeons; never invents monsters (owner-ratified prompt contract: hazards welcome, creatures live in encounters/dungeons — reference where a creature will be encountered instead of statting it) |
| faction-designer | Faction Designer  | faction      | generate | Factions with goals, methods, ranks     |
| plot-architect   | Plot Architect    | note         | generate | Adventure/campaign arcs and hooks       |
| arc-weaver       | Arc Weaver        | plotarc      | generate | Plot arcs with beats, stakes, climax    |
| encounter-smith  | Encounter Smith   | encounter    | generate | Balanced encounters with monsters       |
| encounter-cartographer | Encounter Cartographer | encounter | encounter | Complete room layouts and generated battlemaps |
| continuity-editor | Continuity Editor | note        | review   | Reports contradictions in an artifact   |
| illustrator      | Illustrator       | —            | image    | Drafts an image prompt and generates candidate images for an artifact (M3-A) |

`postCreateExtras` (optional, declared) — the extras the creation dialog
offers for a NEWLY created artifact; unset → derived from `mode`/`producesKind`
(extrasForPersona): every creator offers `image`; npc adds `statBlock`
(verification-only, see finalize); `encounter` adds `mobPortraits`, and the
content-only Smith (mode `generate`) also offers `battlemap` — the
Cartographer (mode `encounter`) already produces the map in-run. Review and
image personas offer nothing. Built-ins declare their sets explicitly.

### Encounter Cartographer pipeline

Mode `encounter` runs fixed steps `brief → layout → schematic → stylize →
verify → pick → finalize`. The LLM brief contains roster sources, room purpose,
adjacency and roster indexes but no coordinates. Pure code packs and validates
geometry; the schematic becomes an image input reference; a multimodal vision
check classifies a coarse floor/wall/void grid and flags mismatches above 12%.
Manual runs pause at brief, layout and map pick; auto picks candidate one.
Regeneration preserves artifact identity, prose, links and roster while
replacing layout/map. Module batches request one candidate and continue after
per-encounter failures. All long paths report through the shared progress dock.

NPC Smith `systemPrompt` (verbatim):

```
You are NPC Smith, an expert at creating memorable tabletop-RPG NPCs.
You write vivid but concise material a GM can use at the table with zero prep.
You ground all mechanical content (stats, abilities, DCs) in the rules excerpts
provided to you, citing book and page when you rely on them. When rules are
missing you make sensible d20-standard assumptions and say so.
Always answer in the exact JSON format requested. Never include commentary
outside the JSON.
```

## Run pipeline (`/src/llm/runEngine.ts`)

A `PersonaRun` executes fixed named steps. The engine is a plain async class
holding the current run; UI observes the run row via `useLiveQuery` (engine
persists the run after every state change) plus an in-memory event emitter for
streaming tokens.

Steps for every persona (M1):

1. **retrieve** — build query from `userBrief` (+ campaign system name), call
   `searchRules(query, { limit: 8 })`, merge with user-pinned chunks
   (pinned first, cap total 12). `output` = chunk ids + titles.
2. **draft** — messages: persona systemPrompt; user message containing:
   campaign name/system/description, the brief, rule excerpts (each prefixed
   `[<bookTitle> p.<pageStart>] <headingPath joined by ' > '>`), and the JSON
   output instruction for the persona's kind (below). Strict structured
   outputs: `responseFormat: schemaResponseFormat('<kind>-draft', schema)`.
   Parse with the kind's zod draft schema. Parse failure → one automatic retry
   appending "Your previous reply was invalid JSON for the schema: <issues>.
   Reply with corrected JSON only." Second failure → run `status:'needs_review'`
   with raw text stored in `output`. Under `auto` autonomy there is no user to
   rescue a rejected draft, so the run **fails** with a "Draft rejected"
   error instead of finalizing an empty artifact (finalize's persona-name
   fallback is unreachable for generate personas). Draft schemas tolerate
   common model variations: bare strings for object lists (pointsOfInterest,
   ranks, beats), objects inside string lists (hooks/prep/openThreads),
   numeric-string counts, and a single string or omitted `suggestedTags`.
3. **statblock** (npc only) — second LLM call asking to fill the `StatBlock`
   JSON schema for this NPC at a user-hinted level (from brief) grounded in the
   excerpts. Same retry policy. Skippable by user.
4. **finalize** — create the Artifact (kind from persona), revision 1,
   `source:'persona'`, `runId` set; link run `resultArtifactId`. The run's
   `placementModuleId` (creation dialog, one-off) is applied on fresh creates
   only — a targeted in-place fill with placement set fails loudly. When the
   stat-block extra is ticked and the created npc has `statBlock: null`,
   finalize persists the notice "No stat block was generated — add one in the
   artifact editor." (never a fabricated block). Post-create extras (image /
   mobPortraits / battlemap) run after completion in the shared unattended
   queues (src/features/campaign/post-run-extras.ts) — a completed run is
   never reopened or failed by them.

### Draft JSON contracts (zod in `/src/llm/schemas.ts`)

`NpcDraftSchema`: `{ name, summary, appearance, personality,
suggestedTags: string[], body, needsStatBlock: boolean }` — `body` is markdown
for the artifact body. The draft contract is deliberately minimal (M4-C
simplification: role/motivation/secrets/voiceNotes were removed — enforced
prose fields made every NPC same-shaped); whatever else a character needs
goes into the free-form `body`. `needsStatBlock` lets the draft skip the
statblock step entirely for characters whose stats don't matter at the table
(contacts, merchants, innkeepers). (Location/Faction draft schemas mirror
their `data` fields; define them in M1 too, they're cheap.)

**Minimum content (owner-ratified empty-text rejection).** `name`, `summary`
and `body` are substance fields: each must carry at least one non-whitespace
character (`substanceText` in schemas.ts — the floor is deliberately one
char, not a prose minimum, so short notes and hooks never over-reject). The
strict JSON schema cannot express this (constraint keywords are stripped),
so the zod parse enforces it at the boundary: a violation is a NAMED issue
riding the existing one-repair turn ("body is empty — …"), then the loud
rejected path (review pause under manual/review, run failure under `auto`).
Finalize re-guards the same invariant — a user-edited draft is not
schema-validated — so an empty body refuses to create or overwrite: an
in-place refill that comes back empty keeps the existing content and fails
the run loudly. Never materialize empty text.

### Autonomy semantics

After each step completes:
- `manual` → status `awaiting_user`; user may **approve**, **edit** (replaces
  `userEdit`, used as the step's effective output), **retry** (re-run step,
  optionally with an extra instruction appended to the prompt), or **cancel**.
  A schema-rejected output cannot be approved as-is: the user must retry or
  supply an edit that validates at that step boundary. Encounter verification
  is the exception — `rejected` there means a valid map exceeded the drift
  threshold and the user may deliberately continue.
- `review` → pause (`awaiting_user`) only if the step is `needs_review`
  (zod failure) — otherwise continue automatically.
- `auto` → no user in the loop: a step whose output fails zod validation
  **fails the run** (`status:'failed'` + `errorMessage`, nothing saved) —
  the engine never falls through a rejected step to finalize placeholder
  output. Completed runs are reviewable afterwards like any other.

Cancel → `status:'cancelled'`, abort in-flight fetch via AbortSignal, no
artifact created. Unexpected exception → `status:'failed'`, `errorMessage` set.

### Monster stat sources (M3-B Encounter Smith)

The Encounter Smith's retrieve step runs a second `searchRules` call restricted
to `chunkTypes: ['statblock']` (the monster-ish nouns of the brief) and presents
those chunks as a numbered "Stat-block excerpts" list. The draft prompt teaches
the citation scheme; per monster the model outputs:

- `sourceChunkIndex: <n>` — finalize maps it back to the cited chunk id and
  persists `{ type: 'rulebook', chunkId }`;
- a full `statBlock` object (only when no excerpt matched) — persisted as
  `{ type: 'inline', statBlock }`;
- neither — name-only `{ type: 'none' }`.

Resolution to displayable stat blocks happens in
`resolveMonsterEntryWithRepos` (origin badges: "NPC: <name>", "Bestiary p. N",
"inline"; dangling refs degrade to a visible "missing ref" badge).

### Image personas (M3-A Illustrator)

> **Owner amendment (2026-09-05, c3c021f):** the prompt-draft step no longer
> makes an LLM call — the chat draft and its one-repair retry are gone; the
> prompt is assembled deterministically from the artifact's own data. Owner,
> verbatim: "i thought we ripped that out… I dont want that extra LLM call.
> Just use the appearance/body."

Steps: `prompt-draft` → `generate` → `pick` (no retrieve — image prompts don't
use rule excerpts).

1. **prompt-draft** — no LLM call: `buildImagePrompt`
   (`src/llm/imagePromptDraft.ts`) assembles `{ prompt, negative, styleNotes }`
   deterministically from the artifact's own data. A non-empty `appearance` is
   used verbatim behind the system label (`"Pathfinder 2e=>…"`, a run
   extra-instruction rides on a second line); otherwise the prompt grounds on
   name + kind, `summary`, and the markdown-stripped `body`
   ("A \<system\> illustration of \<name\> (\<kind\>)."), with empty
   `negative`/`styleNotes`. Nothing to ground on (no appearance, summary AND
   body) is a loud error — never a placeholder prompt (AGENTS rule 1). Pauses
   like a reviewable step: `manual`/`review`
   pause at `awaiting_user`; `auto` continues. The UI presents the three fields
   as editable inputs; continuing stores them as `userEdit: { parsed: … }`
   (the edit wins over the raw output).
2. **generate** — one call to `POST /api/v1/images`
   `{ model: settings.imageModel, prompt, n: 2, output_format: 'webp' }`
   (negative/styleNotes folded into the prompt text). Requires
   `settings.imagesEnabled`; fails with a clear message otherwise. Each
   returned image is stored through the intake pipeline (M3-A §Storage) with
   `source:'generated'`, prompt and model recorded. No pause.
3. **pick** — ALWAYS pauses (`awaiting_user`) on every autonomy level. The UI
   shows candidate thumbnails; the user keeps 0–2. Applying the pick appends
   kept ids to `targetArtifact.imageIds` (first keep becomes the cover if none
   set), prunes discarded candidate blobs, and completes the run with
   `resultArtifactId` = the target artifact.

Runs require `targetArtifactId` (rejected at start otherwise); the run row
persists it. Review/image personas never create artifacts; only generate
personas produce one.

## Acceptance criteria

- With a valid key: brief "a goblin alchemist boss for level 3 party" in manual
  mode pauses after each step, streams tokens live in the panel, and produces
  an NPC artifact with a parsed stat block on approval of all steps.
- In auto mode the same brief runs to completion unattended.
- Invalid API key surfaces a clear error and opens Settings; the run is 'failed'.
- Reloading the page mid-run: run row shows 'failed' with message
  "Interrupted by reload" (engine marks running runs failed on app start).
